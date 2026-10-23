# Docker: todo el runtime dentro de la imagen

mini-tui empaquetado como imagen única. El contrato de diseño es una línea:

> **Las HERRAMIENTAS viven en la imagen; el ESTADO vive en el home montado.**

Así la caja deja de ser un estado acumulado (¿está compilado agent-rs? ¿existe el
modelo de whisper? ¿qué versión de bun?) y pasa a ser un `docker compose up`.
Nada de lo que se ejecuta depende de que el host tenga algo instalado.

| | Dónde | Ejemplos |
|---|---|---|
| **Horneado** (imagen) | `/opt/mini-tui`, `/opt/whisper`, `/usr/local`, `/usr/bin` | la app + `web/dist`, `mini-agent-rs`, `whisper-cli` + `ggml-small.bin`, bun 1.4.3, node 24 LTS, `gh` + `ssh` (openssh-client), python + paquete `mini-sweagent`, git/ripgrep/jq… |
| **Montado** (bind `/home/jaime:/home/jaime`) | el home del usuario | `~/.config/mini-tui` (providers.json con las API keys, sessions.db, skills), los repos sobre los que trabaja el agente, `~/.claude/skills`, la caché de embeddings |

## Build

```bash
docker compose build            # ~10-20 min la primera vez (rust + whisper + vite + pip)
```

Argumentos de build (todos opcionales):

- `WHISPER_TAG` (default `v1.9.5`) — tag de whisper.cpp clonado en el builder.
- `GGML_MODEL_URL` — de dónde baja el modelo. **Cambio respecto al diseño inicial:**
  el espejo `TheSeriousCompanion/ggml-small` responde `401` anónimamente (borrado o
  privado); se usa la fuente canónica `ggerganov/whisper.cpp` (la que usa el propio
  `models/download-ggml-model.sh` de whisper.cpp), fp16 ≈ 466 MB. Si se prefiere un
  cuantizado más ligero, pásalo como URL (p. ej. `Pomni/whisper-small-ggml-allquants`).
- `BUN_VERSION` / `NODE_VERSION` — pins explícitos (1.4.3 / v24.22.1).
- `HOST_UID` / `HOST_GID` (default `1000:1000`) — el usuario `jaime` de la imagen
  coincide con el del host para que los ficheros escritos a través del bind
  sigan siendo editables desde el host. **En otra máquina:**
  `docker compose build --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g)`.
- `BUILD_JOBS` (default `6`) — paralelismo de cargo/cmake en el builder, para
  convivir con otros trabajos de la caja.

El contexto de build es pequeño (~20 MB): `.dockerignore` excluye `.git`,
`agent-rs/target`, `node_modules`, `web/dist`, `benchmark/`, `site/`, logs,
cachés y tests.

## Arranque

```bash
docker compose up -d            # el web escucha en 0.0.0.0:4317 (network_mode: host)
docker compose logs -f mini-tui
docker compose ps               # healthcheck = curl a /api/sessions
```

### Perfiles

```bash
docker compose --profile channels up -d    # + el consumidor de WhatsApp (consumerMain.ts)
docker compose --profile rag up -d         # + servidor RAG (9446) + proyección al grafo
docker compose --profile channels --profile rag up -d
```

- **`channels`** — `bun src/channels/consumerMain.ts`. Todas sus variables de
  configuración (`EVO_INBOX_DB`, `EVO_API_URL`, `EVO_ACCOUNTS`…) se inyectan con
  `env_file: .env` (opcional, nunca horneado) o `environment:` en el compose. El
  servicio fija `EVO_TRANSCRIBE_CPU_QUOTA=""` porque dentro del contenedor no hay
  sesión systemd de usuario: sin eso, cada transcripción intentaría
  `systemd-run --user` (`src/channels/transcribe.ts`). Whisper corre directo.
- **`rag`** — dos servicios:
  - `rag`: `scripts/orchestration_rag.py`, servidor HTTP en `127.0.0.1:9446`
    (`MINITUI_RAG_PORT`). Descarga el modelo de embeddings la primera vez a
    `~/.cache/mini-tui-embeddings` (state → home montado).
  - `rag-sync`: `scripts/orchestration_graph_sync.py` en bucle. Para un paso
    único: `docker compose run --rm rag-sync python3 scripts/orchestration_graph_sync.py --once`.
  - Ambos hablan con `bolt://127.0.0.1:7687` (`MINITUI_GRAPH_URI`), el **neo4j-rust
    del host**: con `network_mode: host` es alcanzable a esa URL exacta, que es
    la que el código ya usa. El grafo y su estado (`~/.config/mini-tui/orchestration-*-status.json`)
    viven en el home.

## Claves y configuración

- **API keys**: `~/.config/mini-tui/providers.json` (el store de proveedores del
  TUI). Entra en el contenedor por el bind de home; **nunca** se hornea en la
  imagen. Verificar: `docker compose exec mini-tui /opt/mini-tui/bin/mini-agent-rs test-model <modelo>`.
- **`.env` del repo** (opcional, `env_file` con `required: false`): variables de
  servicio como las del consumidor de canales. Si no existe, no pasa nada.
- **Skills**: el entrypoint ejecuta `bun scripts/sync-skills.ts` (best-effort) en
  cada arranque: instala los bundled y sincroniza `~/.claude/skills`, todo en el
  home montado.

## El web en el 4317 (o en otro puerto)

Con `network_mode: host` el contenedor comparte el netns: el servicio ocupa el
4317 igual que la instalación del host. **Si el servicio del host sigue corriendo
en 4317, el contenedor no puede ocuparlo** — apagar primero al anfitrión
(mini-tui nativo / su unit systemd) y después `docker compose up -d`. Probar sin
mover nada: un segundo servicio en otro puerto:

```bash
docker compose run -d --name mini-tui-smoke -e MINITUI_WEB_PORT=4319 mini-tui
curl -sf http://127.0.0.1:4319/api/sessions   # Host loopback siempre permitido (hostGuard)
docker rm -f mini-tui-smoke
```

## El TUI dentro del contenedor

```bash
docker compose exec mini-tui bin/mini-tui --version      # una pasada (no interactivo)
docker compose run --rm -it mini-tui bin/mini-tui        # el TUI interactivo
```

`run --rm -it` (no `exec`) para lo interactivo porque `exec` no asigna TTY nuevo
y el TUI dibuja en el que arranca. Con `network_mode: host` el TUI ve los
mismos servicios loopback que en el host. Nota: `bin/mini-tui` avisa si el
checkout va detrás de `origin/main`, pero en la imagen no hay `.git`
(excluido del contexto), así que ese aviso nunca salta dentro del contenedor.

## El agente dentro del contenedor

```bash
docker compose exec mini-tui /opt/mini-tui/bin/mini-agent-rs --help
docker compose exec mini-tui /opt/mini-tui/bin/mini-agent-rs test-model xiaomi/mimo-v2.6-flash
docker compose exec mini-tui /opt/mini-tui/bin/mini-agent-rs --yolo --model=… --task='…'
```

El binario horneado es `MINITUI_AGENT_BIN=/opt/mini-tui/bin/mini-agent-rs`
(features por defecto). La cadena de resolución del TUI lo encuentra solo. La
ruta python de respaldo funciona igual: `import minisweagent` está instalado
(`pip install ./agent`).

**Lane `task-graph` (cola `/queue`)**: el binario horneado se compila SIN la
feature `task-graph` (la cola vive detrás de esa feature; en el host se despliega
como segundo binario `mini-agent-rs-taskgraph`). En la imagen, `queue` responde
"no habla queue" y el resto del agente funciona. Si se necesita dentro:
compilar con `--features task-graph` en el builder y copiar el segundo binario.

## Whisper (transcripción)

```bash
docker compose exec mini-tui /opt/whisper/bin/whisper-cli --help
```

- Binario: `/opt/whisper/bin/whisper-cli` (`EVO_TRANSCRIBE_BIN`), compilado de
  source en el builder, sin CUDA, solo CPU.
- Modelo: `/opt/whisper/models/ggml-small.bin` (`EVO_TRANSCRIBE_MODEL`), **horneado
  en el build** — siempre disponible, no depende de nada en el host.

## Backup del estado

Todo el estado está en el home montado; un backup del host es un backup de
mini-tui. Lo específico:

```bash
# estado de la app (providers, sesiones, skills, claves de canales)
tar czf mini-tui-state.tgz -C /home/jaime .config/mini-tui .claude/skills
# la base de sesiones, en caliente y consistente:
docker compose exec mini-tui sqlite3 ~/.config/mini-tui/sessions.db ".backup '/home/jaime/.config/mini-tui/sessions.db.bak'"
```

La imagen en sí no lleva estado: reconstruible con `docker compose build`.

## Decisiones y límites (honestidad del paquete)

- **`network_mode: host`** en vez de publicar puertos: el web en 4317 idéntico
  al de hoy, y las URLs loopback que el código ya usa (ollama `11434`,
  neo4j-rust `7687`, evo `127.0.0.1`, RAG `9446`) siguen valiendo sin tocar
  configuración. Solo tiene sentido en Linux; en Mac/Windows el host network
  no es el host real.
- **Bind de `/home/jaime`**: paridad de paths — las sesiones del agente escriben
  en `~/.config/mini-tui` y trabajan sobre los repos del host con rutas
  idénticas dentro y fuera. Es la decisión de diseño, con su contrapartida:
  el contenedor ve y puede escribir todo el home. El usuario de la imagen
  (`jaime`, uid/gid del host) es quien escribe, no root.
- **Healthcheck en el compose, no en la imagen**: los perfiles `channels`/`rag`
  comparten la imagen y no sirven HTTP; un HEALTHCHECK horneado los dejaría
  `unhealthy` para siempre. Va en la imagen pero se desactiva en esos servicios.
  Ojo con otro matiz: en host network, un healthcheck contra 4317 pasa también
  si el que escucha es el servicio del host, no el contenedor.
- **`gh` y `ssh` están horneados — el contenedor no es un sandbox**: `gh`
  (GitHub CLI, tarball oficial pinneada) vive en `/usr/bin/gh` a propósito: el
  `~/.gitconfig` del home montado apunta el credential helper de git a esa ruta
  exacta (`!/usr/bin/gh auth git-credential`). `ssh` viene de `openssh-client`.
  Las credenciales son las del host porque el estado entra por el bind:
  `~/.config/gh/hosts.yml` (auth de gh), `~/.ssh/config`, claves y `known_hosts`.
  Así `gh pr create` o `ssh kraken` dentro del contenedor son la misma acción
  que en la terminal de fuera. Ojo: si la clave SSH tiene passphrase y está en
  el `ssh-agent` del host, dentro del contenedor no hay agent — usar clave sin
  passphrase (como las de este host) o montar el socket `SSH_AUTH_SOCK`.
- **bun del home montado**: `src/mini/spawn.ts` prepende `~/.local/bin:~/.bun/bin`
  al PATH de los hijos. Si el host tiene `~/.bun/bin/bun`, los subprocesos bun
  del TUI pueden resolver ese binario (es estático y corre bien en el
  contenedor, pero es drift de versión). El entrypoint y `bin/mini-tui` usan el
  `/usr/local/bin/bun` horneado.
- **Python con `--break-system-packages`**: bookworm bloquea el pip del sistema
  (PEP 668); en un contenedor desechable es lo correcto y evita una venv
  intermedia en el PATH.
- **`security_opt: label=disable` (SELinux)**: en hosts con SELinux enforcing
  (Fedora/RHEL) el dominio del contenedor no puede leer el home montado —
  medido: `EACCES` sobre `providers.json` y `.env` aunque el uid es el correcto.
  La opción `:Z` del bind relabelaría TODO el home a `container_file_t` y
  rompería sshd y el resto de servicios: nunca. Este contenedor es de confianza
  por diseño (monta el home entero), así que corre sin label; la DAC (uid
  `jaime`) sigue aplicando. En hosts sin SELinux el parámetro es inocuo.
- **`rust:slim-bookworm`**: la imagen oficial renombró sus variantes tras la
  release de trixie (`bookworm-slim` → `slim-bookworm`); el builder de este
  Dockerfile usa el nombre actual de la misma base.
- **`fastembed`/`numpy`/`neo4j` horneados** para que el perfil `rag` arranque
  sin tocar la imagen (~+300 MB). El modelo de embeddings NO se hornea: baja
  en el primer arranque al home montado.
