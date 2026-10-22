# BIZ-59 — Benchmark alternativo de harnesses: **Terminal-Bench 2.0 vía Harbor**

| | |
| --- | --- |
| Tarjeta | BIZ-59 (`bd725d47-f11d-4cbb-a0d0-72b8f8472705`), proyecto *Bug Hunt Bench — mini-tui optimizado* |
| Rama / fecha | `agent/mc18-bughunt-20261022` desde `origin/main` · 2026-10-22 |
| Modelo del brazo treatment | `xiaomi/mimo-v2.6-flash` sobre `https://token-plan-sgp.xiaomimimo.com/anthropic/v1` |
| Harness bajo prueba | `mini-agent-rs` (núcleo de mini-tui), compilado de este checkout |
| Licencia del benchmark | Apache-2.0 (harbor-framework/terminal-bench y harbor-framework/harbor) |

---

## 0. Por qué existe este documento

La tarjeta pedía correr **Bug Hunt Bench** (`phuryn/bug-hunt-bench`), pero sus repos sembrados
y *answer keys* están retenidos por el autor. **Decisión de Jaime (2026-10-22)**: no se abre el
issue público en ese repo, ni se publica nada en redes/foros/issues sobre este trabajo; se pivota
a un benchmark **open source ejecutable localmente**. Este documento deja constancia de la
investigación (con fuente citada), la elección, cómo se pluguea mini-tui y el plan con gates.

Regla aplicada a todo lo que sigue: **nada de cifras inventadas**. Lo que no está medido aquí
dice explícitamente que no lo está.

---

## 1. Filtros (todos obligatorios)

1. **Licencia abierta verificable** (SPDX en el propio repo, comprobado hoy vía GitHub API).
2. **Repos públicos sin gating**: se puede clonar/descargar sin cuenta ni aprobación de nadie.
3. **Answer key disponible**: las soluciones de referencia *y/o* los verificadores (tests
   deterministas) viajan en el propio dataset → se puede puntuar en local sin el autor.
4. **Harness CLI local**: instalable por pip/uv, corre en Docker en esta máquina (sin Modal,
   Runta ni otras cuentas cloud).
5. **Mide bugs / código real**, no conocimiento enciclopédico ni tool-use de MCP.
6. **Comparable con la tabla del líder**: score público (resolve rate) + *wall clock* por trial.
7. **Viable hoy**: disco 604 GB libres, Docker 29.8.2 en marcha, límite de la casa
   `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G` para todo lo largo.

---

## 2. Candidatos evaluados (fuente citada, consulta 2026-10-22)

Datos de licencia/estrellas leídos de la API pública de GitHub hoy; el detalle de las filas
«registry» sale de `harbor datasets list --legacy` (guardado en
`~/orq/mc18-bughunt/bench/harbor_datasets.txt`).

| Candidato | Repo (fuente) | Licencia | Answer key / verificador | ¿Pasa los filtros? |
| --- | --- | --- | --- | --- |
| **Terminal-Bench (+ Harbor)** | `harbor-framework/terminal-bench`, `harbor-framework/harbor` | **Apache-2.0** (952★ / 6.4k★) | Cada task trae `solution/solve.sh` **y** `tests/test.sh`; ambos en el dataset descargado | **SÍ — elección** |
| SWE-bench | `SWE-bench/SWE-bench` (6.1k★) | **MIT** | Sí: `FAIL_TO_PASS` + evaluación en Docker ([FAQ](https://www.swebench.com/SWE-bench/faq/): Docker obligatorio) | Sí — fase posterior (misma fase de adaptación vía Harbor) |
| SWE-smith | `SWE-bench/SWE-smith` (812★) | **MIT** | Sí: bugs sintéticos + tests | Sí, pero sintético (menos «bug real») |
| aider polyglot | `Aider-AI/aider` (49.7k★) | **Apache-2.0** (el código); dataset `Aider-AI/polyglot-benchmark` (224★) **sin campo de licencia** en la API | Tests de Exercism por ejercicio | Parcial: benchmark de *coding* desde cero, no de bugs; licencia del dataset sin declarar |
| BugsInPy | `soarsmu/BugsInPy` (153★) | **sin licencia declarada** (API: `license: null`) | Sí (cada bug con tests del proyecto) | **No**: filtro 1 + sin harness CLI estándar (setup manual por proyecto) |
| Defects4J | `rjust/defects4j` (1k★) | **MIT** | Sí (tests JUnit por bug) | **No**: ecosistema Java (Maven/Ant+JDK), sin CLI de agentes; cuello de montaje hoy |
| Multi-SWE-bench | `multi-swe-bench/multi-swe-bench` (366★) | **Apache-2.0** | Sí (tests por instancia) | Sí, pero imágenes multi-lenguaje mucho más pesadas que TB2.0 |
| MCP-Universe | `SalesforceAIResearch/MCP-Universe` (602★) | **Apache-2.0** | Sí | **No**: mide tool-use sobre servidores MCP, no bugs (filtro 5) |
| CoreBench | — | — | — | **No**: no localicé hoy un repo oficial verificable con fuente → descartado por falta de fuente |
| deep-swe | `datacurve-ai/deep-swe` (1.9k★) | **Apache-2.0** | Sí | Sí, pero exige `pier` + red restringida por tarea (más fricción que Harbor+Docker) |
| quixbugs (registry Harbor) | dataset `quixbugs@1.0` (80 tareas: defectos de una línea) | hereda Apache-2.0 del registry | Sí: fix de referencia por bug | Sí — candidato de cross-check (fase 3) |

**Datasets abiertos disponibles hoy en el registry de Harbor** (todos descargables sin cuenta:
`harbor download <name>@<version>`): `terminal-bench@2.0` (89), `terminal-bench-sample@2.0` (10),
`swebench-verified@1.0` (500), `swesmith@1.0` (100), `swebench_multilingual@1.0` (300),
`swebenchpro@1.0` (731), `aider-polyglot@1.0` (225), `quixbugs@1.0` (80),
`terminal-bench-pro@1.0` (200), `ade-bench@1.0` (48), `algotune@1.0` (154), `arc_agi_2@1.0` (167).

### 2.1 Por qué Terminal-Bench 2.0 y no SWE-bench hoy

- **Es el benchmark al que este repo ya le cogió el pulso.** `benchmark/frontier-harness/`
  ya trae `setup-fh-mini.sh` (venv + `harbor` + `terminal-bench@2.0`) y el brazo mini del
  run parcial de 2026-10-10 (`results/mini-agent-rs/README.md`). Reutilizamos esa vía sin
  depender de FrontierHarness Eval, que sí es privado: aquí la puntuación la da el
  **verificador de cada tarea**, que está en el dataset.
- **Answer key a la vista**: `solution/solve.sh` (la referencia) + `tests/test.sh` (el verificador)
  por tarea. Sin account, sin issue, sin autor de por medio.
- **Score + wall clock salen del propio run**: Harbor devuelve `reward` por trial (resolved ≥ 1),
  `agent_execution.started_at/finished_at` (wall del agente) y el wall total del job.
- **Leaderboard público**: el dataset vive en [Harbor Hub](https://hub.harborframework.com/datasets/terminal-bench/terminal-bench)
  con su leaderboard y el repo trae `leaderboard/` (SUBMIT/SETUP/YAML) — el «límite» existe y es
  consultable sin registrarse.
- **Coste de montaje mínimo hoy**: imágenes preconstruidas por tarea en
  `ghcr.io/laude-institute/terminal-bench/<task>:2.0` → el run tira (pull) y no construye nada.
- **Un solo adaptador, muchos benchmarks**: lo que se escriba para Harbor sirve después para
  `swebench-verified@1.0`, `quixbugs@1.0` o `aider-polyglot@1.0` sin tocar el agente.

Contra (y por qué se aceptan): Terminal-Bench no es «solo bugs» — es trabajo real de terminal
(depuración, scripting, compilación, seguridad) con dominios muy variados; y su leaderboard
publica resolve rate, no la columna de wall que tenemos en la tabla interna. Por eso el receipt
interno mide **score + wall por trial** con Harbor y declara la divergencia (sección 9).

---

## 3. Qué mide y cómo se runea

- **Tarea** = `instruction.md` + `environment/` (Dockerfile o imagen pinneada) + `solution/`
  (answer key, solo la usa el agente `oracle`) + `tests/` (verificador) + `task.toml`
  (timeouts, política de red, artefactos).
- **Run**: `harbor run -p <dataset dir> -i <glob> -a <agente> -m <modelo> -n <concurrencia>
  -k <intentos> -y --env docker -o <jobs dir>`. Todo local vía Docker.
- **Score**: `reward` del verificador de la tarea; resolved = `reward ≥ 1` (regla propia de
  Harbor). El job termina con `stats.evals.<arm>.metrics[].mean` = tasa de resolved.
- **Wall clock**: por trial, `agent_execution.started_at → finished_at` (fase del agente, sin
  pull de imagen) y `result.json` del job (started → finished, incluye pull + verificación).
- **Coste/tokens**: `agent_result.n_input_tokens / n_cache_tokens / n_output_tokens / cost_usd`.
  **El endpoint token-plan no publica precios** (`docs/providers-catalog.md`, `xiaomi.yaml`:
  cost tracking `ignore_errors`), así que `cost_usd` se registra tal cual y **el comparador
  válido hoy son los tokens, no dólares**.
- **Red**: las tasks que bajamos no declaran `network_mode`, así que rige el default de Harbor
  (`public`, `harbor/models/task/config.py:70`) → el agente alcanza su proveedor de modelo
  desde dentro del contenedor. Si alguna task lo restringiera, existe `--allow-agent-host`.

### 3.1 Receipt: `benchmark/terminal-bench/receipt/runs.csv`

Una fila por job, escrita **solo** por `record_receipt.py` leyendo los `result.json` del job
(nada tecleado a mano):

`run_id, timestamp_utc, arm, agent, model, dataset, task_filter, n_trials, n_resolved, score,
rewards, agent_wall_s_total, agent_wall_s_median, job_wall_s, tokens_in, tokens_cache,
tokens_out, cost_usd, harbor_version, mini_commit, errors, artifacts`

---

## 4. Cómo se pluguea mini-tui optimizado

### 4.1 El adaptador

`benchmark/terminal-bench/mini_agent_rs.py` — agente custom de Harbor
(`module:Class`, [docs de custom agents](https://docs.harborframework.com/agents/custom-agents)):

- **Hereda de la integración `mini-swe-agent`** de Harbor: `install()` + `run()` +
  conversión mini-swe-agent → ATIF (`populate_context_post_run`). Cambia el binario: en vez
  de instalar el mini-swe-agent de Python, **sube `mini-agent-rs` (estático musl, 14.2 MB)**
  y los YAML de `agent/src/minisweagent/config/` al contenedor.
- **Run**: `mini-agent-rs --yolo --model=<modelo> --task=<instrucción> --output=/logs/agent/mini-swe-agent.trajectory.json
  --exit-immediately -c mini [-c agent.wall_time_limit_seconds=N] [-c agent.step_limit=M]`, con
  `tee` a `/logs/agent/mini-agent-rs.txt`. El cwd es el `WORKDIR` de la task (medido hoy:
  **10/10** tasks del sample y **88/89** de `terminal-bench@2.0` declaran `WORKDIR /app`),
  igual que corre el agente built-in.
- **Trust store de TLS**: el adaptador sube el bundle de CA del host a
  `/usr/local/share/mini-tui/ca-bundle.crt` (copia **regular**, no symlink — en este host
  `/etc/ssl/certs/ca-certificates.crt` es un symlink a `/etc/pki/...` y tar/cp lo copiaría tal
  cual) y exporta `SSL_CERT_FILE`, que `rustls-native-certs`/`openssl-probe` respeta. Sin esto,
  las images de Terminal-Bench 2.0 que **no traen ni un certificado** (medido: `regex-log` tiene
  0 en `/etc/ssl/certs`) matan el agente antes de la primera llamada con
  `invalid peer certificate: UnknownIssuer`. Detalle y evidencia en §6.
- **Credenciales**: `XIAOMI_API_KEY` / `XIAOMI_API_BASE` se resuelven en el host y viajan en el
  **entorno** del exec del contenedor (`passthrough=True`), nunca en argv ni en ficheros del
  repo; Harbor marca las claves como sensibles y las redacta en sus logs. Verificado tras el
  run: ningún artefacto del job contiene la clave.
- **Límites del piloto**: `--ak wall_time_limit_sec=600 --ak step_limit=50` (más el timeout de
  `[agent]` de la task, 900 s) → el piloto no puede colgarse 8 h.

### 4.2 Los cuatro PRs del harness

| PR | Commit | Qué toca | Efecto en **este** brazo (Harbor + `mini-agent-rs` directo) |
| --- | --- | --- | --- |
| **#386** wave grouping | `2f0bb29` | `agent-rs/src/{agent,subagents,subagents_chain}.rs`, `mini.yaml` — un wake por wave, workers sin judge/ceremony | **Solo si hay delegación**: el hub de subagentes arranca siempre, TB es hilo directo → impacto ≈ 0 salvo que el modelo lance hijos. Efecto medido *en el brazo delegado* (repo): orch tp1/tp2/tp4 413/575/248 s → 67/146/98 s (`docs/ANALYSIS-delegation-nx-campaign-20261022.md`) |
| **#387** closure judge | `0c0bcbb` | `agent-rs/src/agent.rs` — se salta el judge de cierre cuando el workspace trae su propio verificador | **No se activa solo** en TB: el verificador de la task corre *después*, fuera del workspace del agente. Se puede forzar/explicitar con `MINI_AGENT_GOAL_ORACLE`. Efecto medido en repo (goal A): 635.5 → 497.7 s |
| **#388** corpus Nx | `7582052` | `benchmark/pi-vs-mini/parallel/*` + `run_bench.py` | **No cambia el agente**: es la infra de medida de escalado Nx (fase 2 de este plan: N-partes con receipt) |
| **#389** direct-lane prompt | `ad19752` | `agent-rs/src/agent.rs`, `mini.yaml` — el lane directo del router recibe el prompt de worker | **Equivalente activo aquí**: en Harbor no hay router, el brazo directo ya corre con el *worker prompt* que #389 instala en el lane directo (mismo `instance_template` de `mini.yaml`). Efecto medido en repo: 66.6 → 30.7 s en task unitaria |

Es decir: **#389 y la disciplina de prompt ya actúan en el brazo que medimos; #386 necesita
delegación (fase 2, con el brazo orchestrator de mini-tui-web); #387 necesita que declaremos
la política de cierre; #388 es el bancos de pruebas para el gate de escalado.** Ninguno de los
cuatro se apaga para este run: se corre el `HEAD` de `origin/main` (commits `2f0bb29`,
`0c0bcbb`, `7582052`, `ad19752` incluidos).

### 4.3 Modelo

- Slug: `xiaomi/mimo-v2.6-flash`; endpoint `XIAOMI_API_BASE=https://token-plan-sgp.xiaomimimo.com/anthropic/v1`.
- `agent-rs/src/models/catalog.rs:368-390`: si la base contiene `/anthropic` → **protocolo
  Anthropic Messages + `set_cache_control: rolling`** y `thinking` acotado a `budget_tokens`
  2048 por defecto (`XIAOMI_THINKING=off` lo desactiva). Esa es la superficie con la que el
  equipo midió la campaña de optimización, así que se usa aquí para que las comparaciones del
  repo no cambien de condiciones.
- Conexión comprobada hoy: `mini-agent-rs test-model xiaomi/mimo-v2.6-flash` → `ok`.

---

## 5. Preparación ejecutada hoy (real, no prevista)

| Paso | Comando | Estado medido |
| --- | --- | --- |
| Harbor | `uv venv --python 3.12 … && uv pip install harbor==0.24.0` | `harbor --version` → **0.24.0** (`~/orq/mc18-bughunt/bench/hbenv`) |
| Datasets (sin cuenta) | `harbor download terminal-bench@2.0`, `terminal-bench-sample@2.0` | **89** y **10** tasks en `dataset/v2` y `dataset/sample` (además de la primera descarga `terminal-bench@latest`, 66 tasks, en `dataset/terminal-bench`) |
| Binario | `cargo build --release --target x86_64-unknown-linux-musl` (con scope CPU 200 %/6 G) | **1 m 28 s**, `static-pie`, 14.2 MB |
| Adaptador | `benchmark/terminal-bench/mini_agent_rs.py` | importa, expone `wall_time_limit_sec` / `step_limit` y sube binario + YAML + bundle de CA |
| Conexión del modelo | `mini-agent-rs test-model xiaomi/mimo-v2.6-flash` (superficie `/anthropic`) | **ok** desde el host |
| Validación oracle (2 tasks) | `harbor run -p dataset/terminal-bench -i *html-js-filter* -i *bun-sourcemap-leak* -a oracle -n 1` | **2/2 reward 1.000, 0 excepciones, 6 m 21 s** (`jobs/2026-10-22__11-53-50`) — pull + verificador + scoring funcionan en esta máquina (tasks de la descarga `@latest`; los runs puntuados usan `dataset/v2` y `dataset/sample`) |
| Piloto acotado | `bash benchmark/terminal-bench/run_pilot.sh` | 3 jobs / 3 filas en receipt: oracle **1.000 (2/2)**, mini v1 **0.500** (1 excepción TLS), mini v2 **0.500** con **0 excepciones** — detalle y gate en §6 |

Todo lo largo corre bajo `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G`.

---

## 6. Resultados del piloto (2026-10-22)

Todas las cifras salen de `benchmark/terminal-bench/receipt/runs.csv`, generado por
`record_receipt.py` leyendo los `result.json` de cada job. Mismo dataset
(`terminal-bench-sample@2.0`), mismas 2 tasks (`fix-code-vulnerability`, `regex-log`),
`-n 1 -k 1`, mismo binario (commit `1914430`, sha del build en la provenance del adaptador).

| job | brazo | score | rewards | agent wall total / mediana | job wall | tokens in / out | excepciones |
| --- | --- | ---: | --- | ---: | ---: | --- | --- |
| `oracle-pilot-20261022-100521` | oracle (sin modelo) | **1.000** (2/2) | fix=1, regex=1 | 0.4 s / 0.2 s | 87.9 s | 0 / 0 | — |
| `mini-pilot-20261022-101010` (v1, **sin** bundle CA) | mini + MiMo V2.6 | 0.500 (1/2) | fix=1, regex=0 | 229.8 s / 114.9 s | 298.1 s | 11 551 / 2 957 | **1**: `regex-log:NonZeroAgentExitCodeError` |
| `mini-pilot-20261022-103205` (v2, adaptador con CA) | mini + MiMo V2.6 | **0.500** (1/2) | fix=1, regex=0 | 1070.0 s / 535.0 s | 1156.7 s | 14 681 / 22 188 | **0** |

Detalle del run v2 (el que lleva el adaptador que se versiona):

| task | reward | agent wall | llamadas al modelo | tokens in / out | excepción |
| --- | ---: | ---: | ---: | --- | --- |
| `fix-code-vulnerability` | **1.0** | 252.1 s | 18 | 12 170 / 5 804 | ninguna |
| `regex-log` | 0.0 | 817.9 s | 2 | 2 511 / 16 384 | ninguna (ver lección 4) |

`cost_usd = 0.0000` en las tres filas: el endpoint token-plan no publica precios
(`docs/providers-catalog.md`), así que **el comparador válido son los tokens**.

### Lecciones del piloto

1. **Imágenes sin trust store.** `regex-log` tiene **0** certificados en `/etc/ssl/certs` y
   ningún bundle: `rustls-native-certs` arranca con cero roots y la primera llamada muere con
   `invalid peer certificate: UnknownIssuer`. Medido: v1 → 0 tokens y
   `NonZeroAgentExitCodeError` en 67.1 s; v2 (con el bundle del adaptador) → **el mismo trial
   llega al modelo** (2 llamadas, 2 511 in / 16 384 out). `fix-code-vulnerability` sí trae 301
   certificados: por eso en v1 esa task funcionó y se resolvió (11 551/2 957, reward 1).
2. **El bundle del host es un symlink.** En este host RHEL `/etc/ssl/certs/ca-certificates.crt`
   apunta a `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`; `docker cp`/tar lo copian tal
   cual y dentro del contenedor queda **colgado** → dos experimentos de diagnóstico dieron
   falsos negativos antes de copiar a fichero regular. Por eso `install()` copia a un
   temporal y sube bytes, no el enlace.
3. **Overhead del run:** en el brazo oracle, 0.4 s de agente dentro de un job de 87.9 s
   (pull + verificación es el coste fijo). Para comparar harnesses hay que usar
   `agent_wall_s_*`, no `job_wall_s` — por eso el receipt trae ambas columnas.
4. **El cap de wall no interrumpe llamadas en vuelo.** `wall_time_limit_sec=600` sólo se
   evalúa entre pasos: `regex-log` corrió **817.9 s** porque una llamada se cayó en streaming
   (`ProviderError: Error while decoding chunks`, con reintentos) y el giro gastó **16 384
   tokens de salida** (`finish_reason=length` en el journal). El techo real lo puso Harbor
   (`[agent] timeout_sec = 900`). En F1 conviene o subir ese cap o asumir que el límite
   efectivo es el de Harbor.
5. **Las dos ejecuciones del brazo mini dan el mismo score (0.500)** con distinto wall: la
   diferencia de v1→v2 no es calidad, es **infraestructura** (TLS) — exactamente lo que el
   gate de F0 separa.

### Gate F0 (evaluado con estos datos)

| Criterio del gate | Estado |
| --- | --- |
| Brazo oracle 2/2 (entorno + verificadores OK) | **PASS** (1.000) |
| Brazo mini sin errores de infraestructura | **PASS en v2** (0 excepciones); v1 los tuvo y motivó el fix |
| ≥ 2 filas reales en `receipt/runs.csv` | **PASS** (3 filas) |

**F0 = PASS → F1 desbloqueado** (sample completo, 10 tasks, mismos flags). Lo que queda para
F1: ventana de máquina libre y las ~10 tasks; nada de lo anterior se estima, se re-corre.

---

## 7. Plan por fases con gates

| Fase | Qué | Comando | **Gate para pasar de fase** |
| --- | --- | --- | --- |
| **F0 — hoy** | Piloto acotado: 2 tasks de `terminal-bench-sample@2.0`, brazo `oracle` + brazo `mini` | `bash benchmark/terminal-bench/setup.sh && bash benchmark/terminal-bench/run_pilot.sh` | Oracle **2/2** (el entorno y los verificadores funcionan); brazo mini **sin errores de infraestructura** (trial con `exception_info` de tipo infra → no se pasa); 2 filas reales en `receipt/runs.csv` |
| **F1** | Sample completo: las **10** tasks de `terminal-bench-sample@2.0`, `-k 1 -n 1`, mini vs oracle | `harbor run -p …/terminal-bench-sample -a mini_agent_rs:MiniAgentRs -m xiaomi/mimo-v2.6-flash -n 1 -k 1` | 10/10 trials cerrados con reward; **score + wall + tokens** en receipt; si score = 0 se documenta el motivo por task (no se retoca el verificador) |
| **F2** | `terminal-bench@2.0` (89) con **A/B de harness**: brazo `mini` (HEAD) vs brazo **control** (commit previo a #386-389, `git worktree`/tag propio, sin tocar otros worktrees) | mismos flags, `-k 1 -n 2` en ventana de máquina | ≥ 80 % de trials sin error de infra; A/B con ≥ 1 repetición; resultado publicado **solo en el repo** (nada externo sin aprobación) |
| **F3** | Cross-check en segundo benchmark con el **mismo** adaptador: `quixbugs@1.0` (80 bugs de una línea) o `swebench-verified@1.0` (500) | `harbor download quixbugs@1.0 …` + mismos flags | Un score + wall más en receipt; confirma que el adaptador no está sobreajustado a TB |
| **F4** | Escalado Nx con #386/#388 (brazo delegado de mini-tui-web sobre tasks que dividen) | runner de `benchmark/pi-vs-mini/parallel` + receipt | S(N) medido ≥ 1 con N=8 (umbral ya alcanzado en repo: 1.62-1.63) y sin regresión en F2 |

Condiciones de parada transversales: la máquina pasa a estar ocupada por otra sesión
(`loadavg` por encima de la ventana pactada), se agota la cuota del proveedor de modelo, o la
fase supera su presupuesto de wall (F1 ≈ 1-2 h, F2 ventana acotada). En cualquiera de esos
casos se deja el receipt con lo corrido y se anota el motivo; **no se rellena con estimaciones**.

---

## 8. Riesgos, divergencias declaradas y límites

1. **No es comparable 1:1 con el leaderboard público**: modelo distinto (MiMo V2.6 vs los
   modelos del leaderboard), Docker local en lugar de Modal/Runta, y wall medido por nosotros.
   Cualquier fila que salga de aquí se publica **solo dentro de este repo/PR**, con estas
   divergencias escritas en la propia fila (`notes`/`errors`).
2. **Coste en dólares no medible**: el endpoint token-plan no expone precios → receipt con
   tokens, `cost_usd` tal cual lo reporte el agente (0.0), sin extrapolar.
3. **`cost_limit` no sirve de red de seguridad** en este proveedor (precio desconocido); las
   protecciones reales son `wall_time_limit_sec`, `step_limit` y el timeout `[agent]` de la task.
4. **Tasks duras**: en `terminal-bench@latest` hay tareas con `expert_time_estimate_hours = 24`
   y en el sample ninguna baja de ~1 h de experto. Un piloto de 2 tasks puede (y probablemente
   debe) quedar en 0 resolved para el brazo no-oracle: eso es un dato, no un fallo del pipeline.
5. **Imágenes grandes**: cada task trae imagen propia en ghcr; disco suficiente hoy (604 GB
   libres), pero F2 (89 tasks) hay que medirlo antes de lanzarlo.
6. **Contención**: Docker está compartido con otros servicios de la máquina; los scopes limitan
   al cliente de Harbor, no al daemon → `-n 1` y ninguna corrida en paralelo con otros benches.
7. **Publicación prohibida**: nada de issues/comentarios/rrss (decisión de Jaime 2026-10-22).
8. **Credenciales**: nunca en el repo, el PR, los logs ni el receipt. El adapter solo las
   reenvía por entorno del contenedor; el script de piloto las lee de `~/.config/mini-tui-web.env`.
   Nota: Harbor las pasa al motor de Docker como `-e K=V` en el argv de `docker compose exec`,
   así que en este host local se ven en `ps` (comportamiento propio de Harbor, idéntico para sus
   agentes built-in); los artefactos del job **no** contienen la clave (verificado con grep
   sobre `bench/jobs/`: 0 coincidencias) y nada de eso se sube a ninguna parte.
9. **El cap de wall no corta llamadas en vuelo** (lección 4 de §6): `wall_time_limit_sec` sólo
   se evalúa entre pasos; el techo efectivo de un trial es el `[agent] timeout_sec` de la task
   (900 s en el sample). Presupuestar F1/F2 con ese techo.

---

## 9. Comandos de referencia (F0, reproducibles)

```bash
# 0) una vez: harbor 0.24.0 + datasets + binario estático (todo en $BENCH_ROOT, fuera del repo)
bash benchmark/terminal-bench/setup.sh

# 1) piloto acotado: oracle (sin modelo) y mini (MiMo V2.6 / surface anthropic), 2 tasks, -n 1
bash benchmark/terminal-bench/run_pilot.sh

# 2) receipt de cualquier job ya corrido (lee sus result.json; no estima nada)
$BENCH_ROOT/hbenv/bin/python benchmark/terminal-bench/record_receipt.py \
  $BENCH_ROOT/jobs/<job> --arm mini --agent mini_agent_rs:MiniAgentRs \
  --model xiaomi/mimo-v2.6-flash --dataset terminal-bench-sample@2.0
```

Ficheros versionados de esta preparación:

| Fichero | Qué es |
| --- | --- |
| `docs/benchmark-alternativo.md` | este documento |
| `benchmark/terminal-bench/mini_agent_rs.py` | adaptador custom de Harbor para `mini-agent-rs` |
| `benchmark/terminal-bench/setup.sh` | instalación idempotente (venv, datasets, binario, provenance) |
| `benchmark/terminal-bench/run_pilot.sh` | piloto acotado F0 (oracle + mini + receipts) |
| `benchmark/terminal-bench/record_receipt.py` | convierte un job de Harbor en fila de receipt |
| `benchmark/terminal-bench/receipt/runs.csv` | receipt: una fila por job, solo con métricas medidas |

---

## 10. Fuentes

- <https://github.com/harbor-framework/terminal-bench> — Apache-2.0, tasks públicas (consultado 2026-10-22).
- <https://github.com/harbor-framework/harbor> — Apache-2.0, harness oficial de Terminal-Bench (consultado 2026-10-22).
- <https://docs.harborframework.com/agents/custom-agents> — cómo se integra un agente propio (`module:Class`).
- <https://docs.harborframework.com/tasks/network-policies> — `public` por defecto, `--allow-agent-host`.
- <https://www.tbench.ai/> · <https://hub.harborframework.com/datasets/terminal-bench/terminal-bench> — dataset y leaderboard públicos.
- <https://github.com/SWE-bench/SWE-bench> (MIT) · <https://www.swebench.com/SWE-bench/faq/> (Docker obligatorio) — candidato descartado para F0.
- <https://github.com/rjust/defects4j> (MIT), <https://github.com/soarsmu/BugsInPy> (sin licencia), <https://github.com/multi-swe-bench/multi-swe-bench> (Apache-2.0), <https://github.com/SalesforceAIResearch/MCP-Universe> (Apache-2.0), <https://github.com/Aider-AI/aider> (Apache-2.0), <https://github.com/SWE-bench/SWE-smith> (MIT), <https://github.com/datacurve-ai/deep-swe> (Apache-2.0).
- Licencias/estrellas leídas de la API pública de GitHub el 2026-10-22; `harbor datasets list --legacy` guardado en `~/orq/mc18-bughunt/bench/harbor_datasets.txt`.
- Evidencia interna: `benchmark/frontier-harness/README.md` (run parcial 2026-10-10), `docs/ANALYSIS-delegation-nx-campaign-20261022.md` (#386-389 medidos), `docs/providers-catalog.md` (precios/limites de proveedores).
