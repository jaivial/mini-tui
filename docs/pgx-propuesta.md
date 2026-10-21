# Propuesta: pgx.dev como base de bases de datos temporales por worktree/sesión en mini-tui

**Estado:** investigación terminada, decisión pendiente de Jaime. **No se ha instalado,
descargado ni ejecutado pgx, y no se ha tocado ninguna base de datos.** Esto es material
de decisión, no un plan de implementación aprobado.

| | |
|---|---|
| Fecha | 2026-10-21 |
| Tarjeta | BIZ-69 — *pgx.dev: investigar y preparar integración en mini-tui* |
| Rama / doc | `agent/mc13-pgx-20261021` → `docs/pgx-propuesta.md` (docs-only) |
| Proyecto estudiado | <https://pgx.dev/> — <https://github.com/pgrundev/pgx> |
| Lecturas | `README.md`, `LICENSE` (AGPL-3.0), `docs/pgx/v0.1-readiness.md`, `docs/pgx/cow-cloning.md`, `docs/pgx/local-dev/{install,cli,ttl,storage,architecture,release-strategy}.md`, `configs/pgx-ephemeral.conf` |

---

## 1. Qué es pgx (resumen honesto)

PGX es un motor de bases de datos escrito en Rust, compatible con el protocolo y el SQL de
PostgreSQL 18 (origen: [pgrust](https://github.com/malisper/pgrust)), pensado para un
ciclo de vida corto: crear miles de bases en milisegundos desde una plantilla sellada,
usarlas minutos y borrarlas. Un solo proceso (`postgres` de PGX) contiene muchas bases
aisladas por nombre/roles/límites; el CLI `pgx` gestiona un clúster bajo `~/.pgx`.

Datos de contexto (todo del propio proyecto, **mediciones suyas, no nuestras**):

- **Beta.** Repo creado 2026-10-08, 234 ★ y 4 issues abiertos al 2026-10-21. Versión v0.1,
  tag propuesto `pgx-v0.1-baseline` aún no creado; tag real `pgx-v0.1-beta.1` (commit
  `913630e11d`) es el motor que PGRun despliega en su beta.
- **Licencia AGPL-3.0** (`LICENSE`), con partes derivadas de PostgreSQL bajo licencia
  PostgreSQL (`NOTICE`). El patrocinador es PGRun (<https://pgrun.dev>), que usa
  PGX como motor de "ramas" efímeras.
- **Compatibilidad:** suite de regresión de PostgreSQL: 219/231 byte-idénticos, los otros 12
  difieren solo en texto de `EXPLAIN`, 0 diferencias de resultado; 36/36 ciclos de
  frameworks reales (Rails 8.1, Django 5.2, Prisma 6, SQLAlchemy 2, node-postgres).
- **Uso aprobado por su propio readiness doc** (`docs/pgx/v0.1-readiness.md`): bases
  efímeras de agente, CI, por PR, test y preview. **No aprobado:** producción, sistema de
  registro, alta disponibilidad, PITR.
- **Durabilidad: `fsync = off`, `full_page_writes = off`** en el perfil efímero
  (`configs/pgx-ephemeral.conf`). Un crash del SO o corte de luz puede perder o corromper
  datos. Existe la opción `pgx init --durability full` (fsync/synchronous_commit/full_page_writes
  **on**), que PGX documenta como "sobrevive a cada commit reconocido".
- **Un solo dominio de crash:** un PANIC o un OOM-kill del runtime tira *todas* las bases
  de ese runtime; el host sobrevive (se aísla con cgroup).
- **Extensiones:** sin extensiones C de terceras partes; solo los módulos contrib de
  fábrica, **pgvector entre ellos**. Sin PL/Python, PL/Perl, PL/Tcl.
- **Copy-on-write depende del filesystem:** `file_copy_method = clone` usa `clonefile`
  (APFS) o `copy_file_range` (Linux). En Linux solo comparte bloques en XFS con reflink,
  **btrfs**, ZFS ≥2.2 con block cloning y bcachefs; **en ext4 hace copia completa "silenciosamente"**.
  En un fs sin cloning, crear una base = copiar todo el template.
- **Rendimiento (cifras suyas):** mint caliente p50 6,2 ms; ~70 KB de RAM por base
  inactiva; 1.000 bases en 128–155 MB; point SELECT 0,25 vs 0,13 ms de PostgreSQL 18
  (1,4–1,9× más lento); scans grandes 1,5–2,2× más lentos; COPY y throughput a 4 clientes
  iguales. El proyecto lo dice explícitamente: *no* afirma ser más rápido que PostgreSQL.
- **Instalación:** `curl -fsSL https://pgx.dev/install | sh` (sin root, verifica SHA-256,
  unpack en `~/.pgx/dist/<ver>`, enlace en `~/.local/bin`), tarball con checksum, o Docker.
  Sin PostgreSQL de sistema.

## 2. Contexto: qué usa hoy mini-tui

- **El estado propio de mini-tui ya es SQLite** (`bun:sqlite` / `node:sqlite`):
  `sessions.sqlite`, `channels.sqlite`, `graph.sqlite` y
  `~/.local/share/mini-tui/task-graph.sqlite` (ver `docs/task-graph.md`). Nada de eso
  necesita PGX: seguiría en SQLite, que es la herramienta correcta para un solo proceso
  local con escritura frecuente.
- **Los workers ya trabajan en worktrees** (`<repo>/.worktrees/<nombre>`, p. ej.
  `newvillacarmen/backend/.worktrees/be-x`), y **el entorno de los hijos se construye en
  `agent-rs/src/environment.rs`** (los `env: BTreeMap<String,String>` de las líneas ~614 y
  ~652, que acaban en `Command::envs`). Ese es el punto natural de inyección de un
  `DATABASE_URL`.
- **Donde encaja PGX:** en la base de datos de la *aplicación que el worker construye o
  prueba* (migraciones, fixtures, tests de esquema, preview del PR), no en los metadatos
  de mini-tui. Si ninguna tarea real de los workers necesita PostgreSQL hoy, el beneficio
  de integrar PGX es 0 y lo correcto es no instalarlo: esa es la primera pregunta de la
  fase 1.

## 3. Modelo de uso concreto propuesto (DB temporal por worktree/sesión)

Todo esto es **diseño propuesto; nada de esto está implementado.**

### 3.1 Topología

```text
                  1 runtime pgx por máquina (proceso único, nuevo daemon — NO arrancado aún)
                  data dir en btrfs con reflink (p. ej. ~/.pgx, en /home)
                  aislamiento extra: systemd-run --scope -p MemoryMax=... (cgroup)
                                     + pgrust.ephemeral_db_connection_limit
                                     │
   template sellado (por proyecto)   ├── mt_tpl_backend  ──clone──► mt_wt_be_x      (worktree be-x)
   pgrust_seal_template(...)         ├── mt_tpl_backend  ──clone──► mt_wt_be_y      (worktree be-y)
                                     └── mt_tpl_web      ──clone──► mt_wt_web_qa    (sesión de prueba)
                                          cada rama: --ttl = TTL de la sesión/card
```

- **Plantilla por proyecto** (`mt_tpl_<proyecto>`): schema base + migraciones + fixtures
  mínimos, sellada una vez. Clonar una rama es `CREATE DATABASE … STRATEGY = FILE_COPY`
  con `file_copy_method = clone` (CoW en btrfs reflink; si no, copia completa).
- **Una base por worktree/sesión**, nombre derivado y estable:
  `mt_wt_<proyecto>_<idWorktree>` (límite: 63 bytes, `^[A-Za-z_][A-Za-z0-9_-]*$`;
  `postgres`/`template0`/`template1` reservados). La convención es lo que permite que la
  relación worktree ↔ base sea computable y no un registro huérfano.
- **TTL = duración de la sesión.** `pgx clone <src> <dst> --ttl 30m` al arrancar la
  sesión/card; `pgx ttl <db> <dur>` para extender; el supervisor de PGX la borra
  automáticamente (mata solo las sesiones de *esa* base, nunca las demás, con
  `DROP DATABASE … WITH (FORCE)`). Si PGX está parado, la limpieza se reanuda al
  arrancar. `unlimited` es el valor por defecto de PGX: **hay que pasar `--ttl` siempre**,
  si no la base queda permanente.
- **Reparto de URL:** `pgx url <db> --json` → se inyecta en el entorno del worker en
  `agent-rs/src/environment.rs` como `DATABASE_URL` (y `PGHOST`/`PGDATABASE` si hace
  falta), junto al `cwd` del worktree. El worker no necesita saber nada de PGX.
- **Registro de la correspondencia:** sidecar por sesión (p. ej.
  `~/.local/share/mini-tui/pgx-dbs.json`: `{worktree, db, ttl, created_at, card}`), que es
  lo que alimentaría un badge en la sesión: *"DB temporal: mt_wt_be_x, expira en 12 min"*.
- **Limpieza al cerrar la sesión:** `pgx drop <db> --force` al cerrar card/sesión, con el
  TTL como red de seguridad para cuando el cierre no llega (crash de mini-tui).
- **Rotación del runtime:** el readiness doc admite ~0,2 KB retenidos por ciclo de vida
  (~20 MB por 100.000); política simple: reiniciar el runtime por número de ciclos o al
  arrancar el desktop.

### 3.2 Qué NO se le da a PGX

| Dato | Dónde va | Por qué |
|---|---|---|
| Grafo de tareas, sesiones, canales, notas | SQLite (actual) | un solo proceso, escritura intensiva, cero dependencias |
| Credenciales y secretos | `~/.cu` vault / `.env` de Jaime | nunca en URLs logueadas ni en el doc/PR |
| Datos que no se puedan recrear | PostgreSQL de sistema o servicio gestionado | PGX no es sistema de registro (su propio readiness doc lo prohíbe) |
| Producción / previews accesibles desde fuera de la máquina | fuera del alcance | nada de despliegues locales ni remotos sin aprobación |

### 3.3 Aislamiento y secretos

- Un solo runtime = un solo dominio de crash: **todas** las DB temporales mueren juntas si
  el runtime muere. Aceptable *solo* porque son recreables (plantilla + migraciones).
- Aislamiento entre workers: por nombre/roles/límites dentro del proceso, más el cgroup
  (`systemd-run --scope -p CPUQuota=… -p MemoryMax=…`) y
  `pgrust.ephemeral_db_connection_limit` como red de vecino ruidoso. No es un sandbox de
  seguridad multiusuario: son procesos de la misma máquina de Jaime.
- La contraseña del superuser es aleatoria y vive en `~/.pgx/config.json` (0600);
  `pgx url` la imprime. **Tratar esa salida como secreto:** no la pegues en logs, PRs,
  capturas ni comentarios de Linear.

## 4. Riesgos

### 4.1 AGPLv3 (el riesgo de licencia)

PGX es AGPL-3.0 completo. **Esto no es asesoramiento legal; es el análisis para decidir.**

- **Riesgo BAJO si PGX se usa como programa externo separado** (obra derivada ajena):
  mini-tui solo ejecuta el binario `pgx` como subproceso por CLI/socket, sin modificarlo
  ni redistribuirlo. Ejecutar un programa AGPL en tu propia máquina no crea obligaciones
  sobre tu código. "Mero agregado" de dos programas independientes.
- **Riesgo ALTO si PGX se distribuye con mini-tui:** mini-tui publica releases e instalador
  (`jaivial/mini-tui`, landing con guía de instalación) y **no declara licencia**
  (`package.json` `private: true`, sin LICENSE en la raíz). Meter el binario de PGX (o
  cualquier binario que enlace su código) en el instalador/imagen de mini-tui es *conveying*:
  obligación de distribuir AGPL-3.0 completo de PGX, `NOTICE`, Corresponding Source y
  avisos, y de no imponer restricciones adicionales. Con el resto de mini-tui sin licencia
  pública, eso crea un lío evitable.
- **Riesgo ALTO si se modifica PGX y se ofrece por red** (sección 13): hay que ofrecer el
  código modificado a los usuarios que interactúen en remoto.
- **Reglas propuestas:** (a) **no empaquetar nunca pgx en releases/installers de
  mini-tui**; (b) no parchear el motor; (c) la documentación, si se llega a escribir, apunta
  a la instalación oficial del usuario final (`curl …/install | sh` o tarball con SHA-256)
  y deja claro que PGX es un proyecto de terceros con su licencia; (d) si algún día
  mini-tui *sirve* bases PGX a terceros por red, revisar sección 13 antes de tocar nada.
  PGX añade que las partes derivadas de PostgreSQL son PostgreSQL License (permisiva).

### 4.2 Durabilidad (la razón principal por la que esto puede no valer)

- **Por defecto `fsync = off`:** un crash del SO o un corte de luz puede perder o
  corromper el contenido de *todas* las bases del runtime. No hay WAL útil, ni PITR, ni HA.
- **Mitigación 1 — todo recreable:** sembrar desde plantilla (migraciones + fixtures en el
  repo), de modo que perder la base cueste segundos. Si un trabajo depende de datos que no
  estén en el repo, esa base no es candidata a PGX.
- **Mitigación 2 — `pgx init --durability full`:** enciende `fsync`/`synchronous_commit`/
  `full_page_writes` (defaults de PostgreSQL). Recupera crash-safety a cambio de
  rendimiento; sería la opción para el caso "quiero PGX pero me da miedo el fsync off".
  Elección de Jaime, fase 1.
- **Mitigación 3 — cgroup:** aislar el runtime con `systemd-run … -p MemoryMax=…` para que
  un OOM mate el runtime y no la máquina (el readiness doc lo valida: bajo
  `memory.max` de 1 GiB el runtime muere y el host sobrevive).
- **Sin vuelta atrás:** si la fase 1 descubre que los workers necesitan datos que no se
  pueden regenerar, la respuesta no es "poner fsync on", es **PostgreSQL de sistema**.

### 4.3 Inmadurez del proyecto

- 13 días de repo público (2026-10-08), beta, un solo sponsor (PGRun), sin tags en el
  engine baseline, 4 issues abiertos; dos bugs reales aparecieron en la primera carga real
  (2026-10-09, corregidos y con reproducción permanente). La superficie compatible es lo
  que cubren su suite y sus workloads: **extensiones no encuestadas**, MVCC/isolation y
  features poco usadas son la zona oscura. 12 planes de `EXPLAIN` distintos de PostgreSQL.
- Versiones ancladas: engine baseline `727f31e49f`, tras los fixes `913630e11d`
  (tag `pgx-v0.1-beta.1`); conviene **fijar commit/versión** en vez de seguir `latest`.
- Factor bus y dirección: PGX es el motor de PGRun; si PGRun cambia de rumbo, mini-tui
  queda con un fork AGPL que alguien tendría que mantener.

### 4.4 Operativa en este escritorio

- Añadiría **otro daemon permanente** a `jaime-desktop` (hoy ya corre el de `cu`). Lo pongo
  explícito: no se arranca ningún proceso de PGX sin el visto bueno de Jaime, y se arrancaría
  bajo scope con límites, no como servicio de sistema.
- `file_copy_method = clone` en ext4 es **copia completa silenciosa**. Este equipo: `/home`
  es **btrfs** (verificado con `df -T`/`findmnt` el 2026-10-21) y un `cp --reflink=always`
  local **funciona**, así que el CoW es plausible; la confirmación definitiva sería
  `pgx doctor` en la fase 1 (no ejecutado). Si el data dir acabara en un fs sin reflink,
  cada clon costaría el tamaño completo del template.

## 5. Plan por fases (con gates de parada)

Cada fase termina en una decisión de Jaime. **Ninguna fase anterior arranca sin la
aprobación de la anterior.**

### Fase 0 — Investigación y propuesta ✅ (esta entrega, 2026-10-21)
Docs leídos, riesgos y modelo escritos. **Cero instalación, cero ejecución, cero cambios
de código.** Entregables: este doc, copia en `/home/jaime/orq/mc13-pgx/propuesta-pgx.md`,
`status.md`, comentario en BIZ-69, PR docs-only.
**Gate:** Jaime lee y decide si vale la pena la fase 1. *(Si la respuesta a "¿alguna tarea
real de los workers necesita PostgreSQL?" es "ninguna", el plan termina aquí.)*

### Fase 1 — Spike manual fuera de mini-tui (requiere aprobación)
- Instalar PGX **fuera** de mini-tui (tarball con SHA-256 o el instalador oficial),
  `pgx doctor` (confirma fs, reflink, libxml2/ICU, puerto), `pgx init --durability
  ephemeral|full`, `pgx run --json`, `pgx clone … --ttl`, conexión con `psql` y con el ORM
  que use el proyecto real del worktree.
- Comprobar: CoW real en btrfs (espacio físico por clon), TTL que expira y no toca otras
  bases, `DROP DATABASE WITH (FORCE)` al final de sesión, límite de conexiones, memoria del
  runtime bajo un scope con `CPUQuota=200%`/`MemoryMax=6G`.
- **Sin tests automatizados nuevos, sin benchmarks inventados:** verificación = build +
  QA manual; cualquier cifra se etiqueta como medida propia, con host, fecha y comando.
- Informe: `docs/pgx-spike-report.md`.
- **Gate no-go:** el fs no clona de verdad, el TTL no se comporta, la compatibilidad con
  el SQL/migraciones reales falla, o el coste operativo no compensa → parar y quedarse en
  SQLite + PostgreSQL de sistema cuando haga falta.

### Fase 2 — Integración mínima y reversible (opcional, fuera de esta entrega)
- Todo **detrás de un flag apagado por defecto** (p. ej. `MINITUI_PGX=1`), cero cambio de
  comportamiento si está off.
- Módulo pequeño que solo invoca el CLI con `--json` (`ls`, `clone`, `ttl`, `url`, `drop`),
  sin librería cliente nueva: el CLI ya expone JSON pensado para agentes.
- Inyección de `DATABASE_URL` en el punto de entorno de `agent-rs/src/environment.rs`;
  registro sesión/worktree ↔ base; TTL = TTL de sesión; drop al cerrar card.
- UI: badge de estado de la DB temporal en la sesión (nombre, expiración, `pgx ls --json`).
- Verificación: build con límites (`systemd-run --scope -p CPUQuota=200% -p MemoryMax=6G`)
  + QA visual manual con `cu` (daemon único ya corriendo). Nada de tests automáticos nuevos
  ni de publicación de nada.
- **Gate:** la DB temporal ahorra tiempo real a los workers sin romper nada; si molesta,
  se apaga el flag y se retira el módulo.

### Fase 3 — Endurecimiento (solo si la fase 2 se usa de verdad)
Plantillas selladas por proyecto, cgroup y límites de conexión como política, rotación del
runtime por número de ciclos, purga de huérfanos (`pgx doctor`), y fijado de versión/commit
de PGX en la config. **Gate:** operación predecible durante un periodo de uso real
(observado a mano).

### Fase 4 — Decisión de escalado
O **se consolida** (¿preview accesible? ¿pgvector para tareas que lo pidan?) o **se
retira**. Producción, despliegues fuera de lo local y compartir la instancia con más que
esta máquina quedan siempre fuera de alcance sin aprobación explícita de Jaime.

## 6. Preguntas para Jaime (decisiones abiertas)

1. ¿Hay tareas reales de los workers que necesiten PostgreSQL hoy? Si no, fin del plan.
2. ¿Vale la pena un daemon más en el escritorio, o solo en sesiones/worktrees concretos?
3. Durabilidad: `ephemeral` (fsync off, rápido) o `full` (fsync on, seguro) para el spike.
4. ¿Instalación de PGX solo en este equipo (recomendado) o documentada para usuarios de
   mini-tui? (Con AGPL, la segunda tiene las obligaciones de la sección 4.1.)
5. ¿Data dir en `~/.pgx` (btrfs, con reflink) y no en `/tmp`? (Recomendado.)
6. ¿Aceptamos el lock-in de fijar un commit de PGX y mantenernos al día nosotros mismos?

## 7. Alternativas consideradas

| Alternativa | Coste | Cuándo gana |
|---|---|---|
| **SQLite (hoy)** | 0 | estado propio de mini-tui: es lo correcto |
| **PostgreSQL de sistema + `createdb` por worktree** | ~16 MB idle por instancia, sin CoW | datos que tienen que sobrevivir; producción; extensiones C |
| **PGX efímero** | ~70 KB/base idle, TTL y clonado CoW | muchas bases de minutos, todo recreable |
| **Docker/Postgres por contenedor** | cientos de MB, arranque lento | aislamiento de proceso ya conocido, imágenes fijas |

## 8. Fuentes

- <https://pgx.dev/> y <https://github.com/pgrundev/pgx> (`README.md`, `LICENSE` AGPL-3.0, `NOTICE`)
- `docs/pgx/v0.1-readiness.md` (uso aprobado, limitaciones, "Not durable")
- `docs/pgx/cow-cloning.md` y `docs/pgx/local-dev/storage.md` (CoW por filesystem, `--durability`)
- `docs/pgx/local-dev/{install,cli,ttl,architecture,release-strategy}.md`
- `configs/pgx-ephemeral.conf` (perfil `fsync = off`)
- mini-tui: `docs/task-graph.md`, `agent-rs/src/environment.rs`, `package.json`
