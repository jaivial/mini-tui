# Subagentes atascados en `waiting` / `Submitted` - diagnostico

Fecha: 2026-10-09. Sesiones implicadas: `s-mv0t5k3za819` (PR de estadisticas, hijos `be-affluence` /
`fe-affluence`), riesgo activo en `s-mv17qtrw9257` (orquestacion pi-speed, hijo `analysis-doc`).
Rama: `fix/stuck-subagents`.

## Sintoma

En el panel de agentes de mini-tui web hay subagentes que aparecen como
`waiting` / `Submitted` (o `running`) eternamente, sin arrancar nunca un turno nuevo y sin
disparar la continuacion de la orquestacion. El estado se congela aunque el proceso haya muerto.

## Que se ha verificado (evidencia)

1. **El run de stats SI arranco y completo sus dos hijos.** Ambos reportaron `done`
   (`subagents/events.jsonl` del run `2026-10-09T10-13-50-trabaja-orquestando-con--77e58d`,
   10:24 y 10:39) y el padre recibio las notas `[subagent be-affluence] finished its turn:
   Submitted` (10:24:43) y `[subagent fe-affluence] finished its turn: Submitted` (10:39:09), y
   actuo sobre ellas (envio el fix del bug de fechas a `be-affluence`, la orden de no usar cu a
   `fe-affluence`). Los PR #427 y el frontend se crearon. **No hubo perdida de trabajo.**
2. **71 hijos "fantasma" historicos.** Escaneando todos los `subagents/index.json` de
   `~/.config/mini-tui/runs`: 71 entradas con `state` en `running|starting|waiting` cuyo pid ya no
   existe (o esta reciclado) y cuyo `socket` apunta a un runtime `/tmp/mini-agent-<pid>-<hex>`
   eliminado. Solo 1 de 72 esta realmente vivo (`analysis-doc`, pid 3975744). Ejemplos:
   `be-affluence`/`fe-affluence` (pid 2302275/2302276, muertos, index congelado a las 10:39);
   `cinepolis`/`autores`/`agregadores` (run de la cartelera 12:16, index congelado en `running`
   con steps 109/55 y turns 0).
3. **El congelamiento del indice es posterior a la muerte del padre.** Run de stats: la trayectoria
   del padre termino a las 10:53 y el `index.json` quedo escrito por ultima vez a las 10:39 (nunca
   se reescribio al morir). Run de la cartelera: `agent.exit pid=3689526 code=143` (SIGTERM,
   journald 12:33:21) e `index.json` escrito a las 12:33:18 con dos hijos en `running`.
4. **Los hijos en `waiting` nunca salen solos.** Un hijo `waiting` se queda en
   `wait_for_followup()` (agent-rs/src/agent.rs:368-406), bucle infinito de 200 ms leyendo
   `MSWEA_CONTROL_FILE` (el hub se lo puso al lanzarlo, agent-rs/src/subagents.rs:1814). Solo sale
   por senal. Mientras tanto retiene ~15-25 MiB y un pid, y `live_runs` lo anuncia como vivo.
5. **El web cierra la sesion con SIGTERM y eso mata al padre sin limpieza.**
   `SessionManager.close()` (src/web/sessions.ts:1308) hace `entry.run.kill()` -> SIGTERM al
   proceso padre (code=143 en journald). En `on_signal` (agent-rs/src/main.rs:178-205) la rama de
   SIGTERM hace `killpg(CHILD_GROUP, SIGKILL)` (el grupo del *comando en curso*) y re-raise de
   SIGTERM con el handler por defecto: el proceso **muere sin correr destructores**, sin
   `subagents::shutdown()` y sin `write_index()`. `die_by_signal()` (que si limpia) solo se usa en
   el camino de SIGINT/KeyboardInterrupt de `run()`.
6. **El panel muestra el estado del indice, no el del proceso.** `SubagentSync.sync()` lee
   `index.json` (src/mini/subagents.ts:92) y `#announce()` (src/mini/subagents.ts:204-214) declara
   vivo cualquier hijo con `state` en `running|starting|waiting`, sin mirar el pid. Con el indice
   congelado, la fila queda en `waiting - Submitted` (que el UI dibuja como "done") o `running`
   para siempre. `foreignRunAlive()` (src/mini/spawn.ts:336-361) si comprueba el pid, pero solo se
   consulta al abrir o enviar a esa sesion (`#attachExternal`), no en cada tick de sync.

## Causa raiz

**El hub no persiste el estado real al morir la sesion, y el lector (mini-tui web) confia en
`index.json` como si fuera verdad en vivo.** Dos defectos encadenados:

* **(A) Descarga sucia del hub.** En el camino de salida limpio (`Ok(_)` de `agent.run`,
  main.rs:298) el `Guard` corre y `shutdown()` reescribe el indice. En los caminos de senal
  (SIGTERM: cierre de sesion web, reinicio del servicio) y en cualquier muerte abrupta
  (SIGKILL/OOM/crash) no se escribe nada: el `index.json` queda congelado con el ultimo estado y
  los hijos supervivientes quedan huerfanos pegados a su control file.
* **(B) El lector no desmiente al indice.** `#announce()` anuncia vivo por estado, no por pid, y
  un hijo `waiting` es un proceso que nunca termina solo. Resultado: tras cualquier cierre de
  sesion web se acumulan filas "vivas" fantasma y procesos huerfanos.

El `LimitsExceeded` de `analysis-doc` (s-mv17qtrw9257) es el mismo mecanismo en vivo: el hijo
termino su turno, quedo `waiting` con exit_status `LimitsExceeded`, y su proceso sigue vivo
consumiendo memoria mientras el padre sigue trabajando. Si esa sesion se cierra con SIGTERM, ese
hijo se convierte en otro fantasma mas.

## Fix propuesto

**Fix 1 (Rust, el esencial): que la muerte del padre sea limpia.**
En `on_signal`, para SIGTERM, llamar `subagents::shutdown()` antes del re-raise (exactamente lo
que ya hace `die_by_signal()` para SIGINT). Eso (a) interrumpe los hijos con SIGINT (ellos
guardan su conversacion), (b) los mata tras la gracia, (c) marca `stopped` y **reescribe
`index.json`**, y (d) borra el runtime del socket. Minimo, local, sin cambiar el protocolo.

**Fix 2 (TS, defensa en profundidad): que el lector no anuncie fantasmas.**
En `SubagentSync.#announce()`, comprobar la vida del pid antes de `registerLiveRun` (una sola
comprobacion por cambio de `pid:traj`, cacheada con `#announced`), y retirar el anuncio cuando el
pid no responde. Un indice congelado por cualquier razon (SIGKILL, OOM, crash del hub) deja de
verse como trabajo vivo.

**Fix 3 (Rust, higiene, opcional / no incluido): limite de vida para un hijo `waiting`.**
`MINI_AGENT_WAIT_TIMEOUT_S` (0 = sin limite, default 0) que al expirar cierre el proceso hijo
guardando su conversacion (mismo camino que `agent stop`). Evita la acumulacion de hijos pegados
al control file cuando la sesion que los creo ya no esta. Dejado como propuesta: cambia
semantica de retencion de contexto y merece decision aparte.

## Que NO es la causa

* No es el plan scheduler (`tick_plan`): en el run de stats no habia plan; los hijos se lanzaron
  con `agent delegate`, que arranco y completo ambos.
* No es el warmup (`launch_jobs` / `Warm::wait_done`): la delegacion de stats espero 2.2 s y
  ambos procesos nacieron (pids 2302275/2302276 reales, steps 18 y 70).
* No es perdida de notas: el padre leyo las dos notas y actuo sobre ellas.
* No es `MINI_AGENT_MAX_SUBAGENTS` ni el OOM guard: 2 hijos, memoria de sobra.
* No es `agent.log` vacio por fallo de arranque: los logs vacios corresponden a hijos que no
  escribieron nada en stderr; los errores de proveedor (429, 402, modelo desconocido) si quedan
  registrados en otros runs y no es el patron de este incidente.

## Riesgo para la orquestacion en curso (s-mv17qtrw9257)

El hijo `analysis-doc` esta `waiting - LimitsExceeded` y su proceso sigue vivo (pid 3975744). El
padre sigue trabajando. Si el padre muere por SIGTERM (cierre de pestana/sesion en el web o
reinicio del servicio), el hijo queda huerfano y el indice congelado: otro fantasma. El Fix 1
evita exactamente ese escenario. Ninguno de los fixes requiere tocar `mini-tui-web.service` ni
reiniciar nada: son cambios de codigo en rama + PR.

## Notas de verificacion

* Fix 1: `cargo build --release` en `agent-rs/` (compila limpio).
* Fix 2: suite existente de `tests/subagents-sync.test.ts` sigue pasando (no se escriben tests
  nuevos: regla dura del encargo).

Reproducido y verificado en vivo (2026-10-09, /tmp/stuck-repro, binario viejo del servicio vs
binario de la rama; nada del servicio ni de otros runs se toco):

1. PADRE VIEJO + hijo `worker` running + `kill -TERM <padre>`:
   padre muere, hijo muere (iba en el grupo del padre), pero `subagents/index.json` queda
   congelado con `worker: running, exit_code: null` y `/tmp/mini-agent-<pid>-<hex>` no se
   limpia. Exactamente el sintoma del incidente (72 fantasmas escaneados).
2. PADRE NUEVO (con Fix 1) + hijo `worker` running + `kill -TERM <padre>` (x2 escenarios):
   padre muere en ~0.4 s (muy por debajo del SIGKILL de respaldo de 5 s del web), el hijo
   muere, `index.json` se reescribe con `worker: stopped` y el directorio runtime se elimina.
3. Fix 2 evaluado directamente: `toView` con pid muerto y estado `waiting` devuelve `dead`;
   con pid vivo devuelve `waiting`; `exited` no se toca. `bun x tsc --noEmit` y
   `bun run check` (web) limpios (el unico warning es un CSS preexistente).

Coste en el caso feliz: un `kill(pid, 0)` por entrada cuyo estado cambia de todas formas en
cada tick del monitor; sin I/O extra mientras el estado no cambia.
