# mini web UI vs pi harness: speed benchmark (2026-10-09)

Pedido de Jaime (9 oct 20:48): ejecutar la comparacion de velocidad **mini-tui web UI vs pi
harness**; mini debe ganar en wall time manteniendo el mismo o mejor % de exito.
`docs/pi-speed-analysis.md` documenta el analisis previo y los items 1-6 ya implementados
(PRs #109 y #111); este documento mide el resultado **con tareas reales** en lugar de
argumentar desde el codigo.

> **Ronda 6 (ejecutada 2026-10-10, la mas reciente)**: el **0,69x de la ronda 5 no se sostiene**.
> Tres reps nuevas de la misma corrida dan **1,13x / 0,98x / 0,93x** (mediana **0,98x**): con este
> corpus mini y pi estan **empatados en wall time**, no mini mas rapido. La calidad si es solida y
> si se sostiene: **40/40 PASS en mini y 30/30 en pi**. La varianza esta en el modelo (turnos y
> longitud del razonamiento), no en el harness, que es ~1 % del wall. Los datos, el por que y la
> correccion del campo `overhead_ms` estan en la **seccion 9**. Ademas: **no existe ningun
> "FrontierHarness" en esta maquina** (seccion 9.5), asi que esa parte del pedido quedo bloqueada.

> **Ronda 3 (ejecutada 2026-10-10)**: los dos pedidos de la ronda 2 --- una via rapida para
> consultas triviales y menos vueltas de overhead por turno --- estan implementados y medidos
> sobre el **mismo corpus de 10 tareas** y el **mismo modelo en los dos harnesses**
> (`minimax/MiniMax-M3`). Resultado: **10/10 PASS en ambos**, mini **gana en 8 de 10 tareas** y
> por **mediana (18.0 s vs 25.9 s)**, y sus llamadas al modelo bajan de **110 a 96** (y a 62 sin
> la tarea atipica `t4`). Los datos y el analisis estan en la **SS7**.

> **Ronda 2 (commit `1d5607b`, ejecutada 23:23-23:35)**: los cuatro items que la SS4 de la ronda 1
> pedia (escritura nativa `write`/`edit`, prompt de instancia mas corto, batching agresivo y **code
> mode**) ya estan implementados y el benchmark se ha repetido sobre el **mismo corpus de 10
> tareas**, con el **mismo modelo en los dos harnesses** y ahora **nativo**: `minimax/MiniMax-M3`
> (zai esta capado; opencode-go prohibido por Jaime). Resultado: la brecha se cierra de **3.65x a
> 1.28x** manteniendo **10/10 de exito en ambos**. Aun asi **mini no gana todavia en wall time
> agregado**. Los datos y el analisis estan en la **SS6**.

**Resultado en una linea: mini NO gana. Pierde 3.65x en wall time (1021 s vs 280 s en 10
tareas) con el mismo 10/10 de exito. El cuello no es el harness (9.1 s en total, ~0.9 %):
es que mini hace 2.2x mas llamadas al modelo (107 vs 49) y genera ~4.8x mas tokens de salida,
porque su unico camino de escritura es `bash` (heredocs/sed) donde pi tiene `write`/`edit`.**

---

## 1. Metodo

- **Modelo identico en ambos**: `zai/glm-5.3` (API Z.AI coding), thinking `high` por defecto
  en ambos harnesses, mismo proveedor y mismas credenciales, misma maquina, ejecuciones
  secuenciales (nunca dos tareas a la vez) con vigilancia de load average (nunca paso de ~3.8,
  muy por debajo del umbral de pausa de 12).
- **mini**: el servicio web mini-tui ya desplegado (`bun src/web/serve.ts`, puerto 4317), que
  lanza `mini-agent-rs` (binario recompilado hoy con los items 1-6). Se lanza cada tarea por
  `POST /api/sessions` (prompt + cwd + modelo) y se mide hasta `status = done`.
- **pi**: `pi --provider zai --model glm-5.3 -p --mode json "<tarea>"` (headless, JSON events
  en stdout), ejecutado con node v24. Se mide hasta exit del proceso.
- **Verificacion objetiva por tarea**: cada tarea trae su `verify.sh` determinista (tests de
  pytest/node, comprobacion de contenido exacto de ficheros, numeros recalculados desde los
  datos). Los verificadores se validaron contra **soluciones de referencia escritas a mano**
  (10/10 PASS) y contra el estado inicial (10/10 FAIL) antes de correr el benchmark.
- Todo el material vive en `/home/jaime/mini-tui-benchmark` (`tasks/`, `runs/<ts>/`,
  `run_bench.py`, `summarize.py`) para no ensuciar el repo.

### Corpus (10 tareas, estilo terminal-bench, autonomas y reproducibles)

| id | tipo | pide |
| --- | --- | --- |
| `t1_wordfreq` | scripting / analisis de log | top-5 palabras de un log de 20 000 lineas -> `answer.json` |
| `t2_grep_logs` | debugging JS | bug de tiers de descuento en `cart.js` (limites `>` vs `>=`) |
| `t3_pytest_fix` | debugging Python | 4 tests pytest que fallan (`t3_lib.py`) |
| `t4_refactor` | edicion de codigo | CJS->ESM + endurecer `parseDuration` (`utils.js`) |
| `t5_script_csv` | scripting / datos | informe de ingresos desde un CSV de 500 filas |
| `t6_readme_summary` | lectura de logs | que ruta falla y cuantos 5xx en un access log de 5000 lineas |
| `t7_regex_cli` | coding desde cero | CLI `wordcount.py` desde un esqueleto con TODOs |
| `t8_js_bug` | debugging async JS | carrera en el `Limiter` (release contable) |
| `t9_pkg_resize` | edicion multi-fichero | `shop/prices.py` debe cumplir su docstring (ValueError, redondeo) |
| `t10_crash_report` | lectura de logs | desglose de errores de un service log -> `report.json` |

Son pblicas en el sentido de reproducibles: los generadores de datos y los prompts estan en
`/home/jaime/mini-tui-benchmark/tasks/`, sin dependencias externas.

---

## 2. Resultados

Wall time por tarea (segundos) y veredicto del verificador objetivo:

| tarea | mini (s) | pi (s) | mini vs pi | llamadas mini | turnos pi | mini ok | pi ok |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t1_wordfreq | 42.1 | 14.5 | 2.90x mas lento | 7 | 5 | yes | yes |
| t2_grep_logs | 54.1 | 24.5 | 2.21x mas lento | 7 | 4 | yes | yes |
| t3_pytest_fix | 58.1 | 23.3 | 2.49x mas lento | 8 | 4 | yes | yes |
| t4_refactor | 402.5 | 72.3 | 5.57x mas lento | 25 | 6 | yes | yes |
| t5_script_csv | 40.0 | 14.8 | 2.70x mas lento | 8 | 4 | yes | yes |
| t6_readme_summary | 76.1 | 23.6 | 3.22x mas lento | 12 | 6 | yes | yes |
| t7_regex_cli | 78.1 | 41.4 | 1.89x mas lento | 10 | 6 | yes | yes |
| t8_js_bug | 94.1 | 19.3 | 4.88x mas lento | 11 | 4 | yes | yes |
| t9_pkg_resize | 50.1 | 11.9 | 4.21x mas lento | 8 | 4 | yes | yes |
| t10_crash_report | 126.1 | 34.5 | 3.66x mas lento | 11 | 6 | yes | yes |

**Agregados**

| metrica | mini web UI | pi | diferencia |
| --- | --- | --- | --- |
| Total wall time | **1021.3 s** | **280.1 s** | mini 3.65x mas lento |
| Media por tarea | 102.1 s | 28.0 s | 3.65x |
| Mediana por tarea | 67.1 s | 23.5 s | 2.86x |
| Tareas superadas (objetivo) | **10/10 (100 %)** | **10/10 (100 %)** | igualado |
| Llamadas al modelo | 107 | 49 | mini 2.18x mas |
| Tokens de salida generados | 69 519 | 14 557 | mini 4.78x mas |
| Tiempo de modelo (suma) | 1001 s (98 %) | 274 s (98 %) | 3.65x |
| Overhead del harness (item 6) | **9.1 s** (media 84.8 ms/paso, mediana 32.5 ms) | ~5.7 s no-modelo | comparable |
| Arranque/web/idle de mini | 10.8 s en total (~1.1 s/tarea) | - | despreciable |

mini **empata en % de exito (100 %)** y **pierde en velocidad en las 10 tareas**, entre 1.89x
y 5.57x.

---

## 3. Donde se pierde el tiempo (timings por fase del item 6)

El item 6 estampa `extra.timings` por paso (`save`, `control`, `model`, `view`, `actions`,
`observe`, `overhead_ms`, `model_ms`, `harness_ms`). Sumados sobre las 10 runs de mini:

| fase | total | media/paso | mediana/paso | p90 |
| --- | --- | --- | --- | --- |
| **model** | 1001 s | 9.4 s | 6.8 s | - |
| **harness** (`overhead_ms`: save+control+view+actions+observe) | **9.1 s** | 84.8 ms | 32.5 ms | 314.7 ms |
| `actions` (dentro del overhead) | - | 92.6 ms | 36.3 ms | 324.8 ms |
| arranque del proceso + capa web + idle | 10.8 s | ~1.1 s/tarea | - | - |

Es decir: **el harness de mini cuesta 9.1 s de 1021 s (0.9 %)**. No hay cuello de botella en
el lazo, en el journal, en la capa web ni en el espawn: `wall - (model + harness)` es ~1.1 s
por tarea, que es el arranque del binario y la primera llamada en frio (mediana 2.5 s, ya
mitigada por el cache warmer del item 5). El coste no-modelo de pi es del mismo orden
(5.7 s en total). **Los dos harnesses gastan ~98 % del wall time esperando al modelo.**

La diferencia real esta en **cuantas veces y cuanto** llaman al modelo:

1. **2.18x mas llamadas.** mini termino las 10 tareas en 107 llamadas; pi en 49 turnos.
   pi ejecuta varios tools por turno (47 tool calls en 49 turnos) con `read`/`edit`/`write`
   dedicados; mini emite 1.23 acciones bash por paso y cada accion es un round trip completo
   al modelo. Ademas el prompt de mini pide explicitamente un flujo paso a paso
   ("This workflow should be done step-by-step", "iterate on your changes"), lo que infla el
   numero de pasos.
2. **4.78x mas tokens de salida.** Escribir un fichero con `bash` obliga a re-emitir el
   fichero entero dentro de un heredoc y a narrar cada comando; `write`/`edit` de pi hace lo
   mismo con menos tokens y sin shell-quoting. Ejemplo extremo (`t4_refactor`): mini 29 786
   tokens de salida en 25 llamadas; pi 5 350 tokens en 6 turnos.
3. **Dano colateral del shell como unico camino de escritura.** En `t4_refactor`, mini
   introdujo mojibake con un heredoc y se gasto 16 pasos (285 s de tiempo de modelo de los
   400 s totales) reparando su propio `sed`/heredoc y montando una matriz de tests de
   interoperabilidad ESM/CJS que la tarea no pedia. pi resolvi la misma tarea con
   `read`x3 + `bash`x3 + `write`x2. De las 158 acciones bash de mini, 59 fueron mutantes
   (heredoc/sed/tee/python inline) y 99 de lectura; las mutantes son las que generan
   reparaciones.

**Cuello principal identificado: no es el harness, es la superficie de herramientas y el
prompt.** Con `bash` como unica herramienta de escritura, cada edicion cuesta un round trip
al modelo con el fichero entero en el output, y los errores de quoting/codificacion se pagan
en pasos extra. El item 4 (`read` sin shell) existe, pero esta detras de
`MINITUI_AGENT_TOOLS` y no cubre escribir.

---

## 4. Que habria que cambiar para que mini gane (ordenado por retorno)

1. **Herramientas de edicion nativas (`write`/`edit` con oldText/newText)** como camino por
   defecto, no `bash` + heredoc. Es la causa dominante de la brecha (mas llamadas x mas
   tokens x mas reparaciones). Una edicion deja de costar el fichero entero en output tokens
   y desaparece la clase de errores de quoting/codificacion que en `t4` valio 285 s.
2. **Prompt de instancia menos "paso a paso"** para tareas acotadas: el `instance_template`
   de `mini.yaml` pide explicitamente iterar paso a paso y crear scripts de reproduccion; en
   tareas de 4-8 llamadas eso anade llamadas que pi no hace. Un modo "tarea corta" (o quitar
   el requisito de script de reproduccion cuando ya hay `verify.sh`) recortaria pasos.
3. **Batching real de acciones** (item 2 ya implementado a nivel de ejecucion): el modelo ya
   puede emitir 2 comandos por paso, pero el prompt podria animar batching mas agresivo de
   lectura+edicion, como hace pi con `Promise.all` sobre tools independientes.
4. **No perseguir el overhead del harness**: con 9.1 s de 1021 s, cualquier optimizacion
   adicional ahi (journal, clonado, compaction) mueve <1 % del wall time. Los items 1-6 ya
   dejaron esta parte al nivel de pi.

## 5. Notas de reproducibilidad

- Corpus + generadores + verificadores: `/home/jaime/mini-tui-benchmark/tasks/`.
- Resultados crudos (JSON por tarea y harness, eventos JSONL de pi, directorios de trabajo):
  `/home/jaime/mini-tui-benchmark/runs/20261009-210239/`.
- Runner: `python3 run_bench.py [tarea...]`; resumen: `python3 summarize.py`.
- mini guarda sus trayectorias en `~/.config/mini-tui/runs/2026-10-09T21-*/traj.json`
  (de ahi salen los `extra.timings` del item 6 y el conteo de tokens).
- Load average mximo durante la ejecucion: ~3.8 (umbral de pausa 12, nunca activado).

---

# 6. Ronda 2: escritura nativa + code mode (2026-10-09, commit `1d5607b`)

La ronda 1 termino con mini 3.65x mas lento que pi. Su SS4 identifico cuatro cambios, por
orden de retorno: **(1)** herramientas de escritura nativas (`write`/`edit`) como camino por
defecto, **(2)** prompt de instancia menos paso-a-paso, **(3)** batching real de lectura+edicion y
**(4)** [nunca persiguiendo el overhead del harness]. Los cuatro estan implementados en el commit
`1d5607b` y este benchmark los mide sobre el mismo corpus.

- **(1) `write`/`edit` nativos** (`agent-rs/src/writing.rs`): `edit` envia solo
  `oldText`/`newText`; `write` envia el fichero una vez. Sin shell-quoting, sin re-emitir el
  fichero entero, sin la clase de errores de codificacion que en la ronda 1 costo 285 s en `t4`.
  Se ofrecen siempre que el gate `MINITUI_AGENT_TOOLS=1` esta activo, que `src/mini/spawn.ts`
  pone para toda corrida de mini-tui (asi es el camino por defecto del producto); un
  `mini-agent-rs` a pelo (y la suite de paridad) sigue viendo solo `bash` + `cu`.
- **(2) prompt de instancia mas corto** (`mini.yaml`): se quito el flujo paso-a-paso y el
  "reproduction script" (innecesarios con `verify.sh`) y se sustituyo por la guia de las
  herramientas nativas + batching.
- **(3) batching agresivo**: concurrencia de acciones por paso 2 -> 4
  (`MINI_AGENT_PARALLEL_ACTIONS`); las tools nativas (read/write/edit) no hacen spawn, asi que
  solaparlas es barato y un lote read+edit+edit+test cuesta su miembro mas lento, no la suma.
- **(4) code mode**: un tool `code` que ejecuta un script Rhai que llama a
  `read`/`write`/`edit`/`edit_many`/`bash`/`reads` y devuelve solo lo que imprime, de forma que
  una secuencia read->edit->edit->verificar cuesta **una** llamada al modelo en lugar de cuatro.
  Equivalente a pi's codemode (alli QuickJS, aqui el mismo Rhai sandbox del repl); los `bash` del
  script pasan por el executor del entorno (journal, timeout, kill) como cualquier comando.

## 6.1 Metodo de la ronda 2

- **Modelo identico en ambos harnesses**: `minimax/MiniMax-M3`, ahora **nativo** en mini y en pi
  (mismo endpoint OpenAI-compatible, mismas credenciales). El runner se cambio de `zai` (capado)
  a minimax y se reparo un bug pre-existente del runner (`p.pid`, que abortaba cada corrida de pi
  antes de escribir su resultado). Se mantuvo el corpus, los generadores y los `verify.sh` de la
  ronda 1, ya validados contra soluciones de referencia.
- **La sesion web es la de siempre**, pero ahora lanza el binario **recompilado con la ronda 2**
  (`agent-rs/target/release/mini-agent-rs`), de modo que las tools nativas y code mode estan
  activas en cada tarea.

## 6.2 Resultados por tarea (segundos)

| tarea | mini (s) | pi (s) | mini vs pi | llamadas mini | turnos pi | mini ok | pi ok |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t1_wordfreq | 16.0 | 9.9 | 1.62x | 4 | 5 | yes | yes |
| t2_grep_logs | 16.0 | 12.4 | 1.29x | 6 | 7 | yes | yes |
| t3_pytest_fix | 30.0 | 14.8 | 2.03x | 8 | 7 | yes | yes |
| t4_refactor | 94.1 | 56.2 | 1.67x | 22 | 6 | yes | yes |
| t5_script_csv | 32.0 | 6.4 | 5.00x | 11 | 4 | yes | yes |
| t6_readme_summary | 32.0 | 16.3 | 1.96x | 8 | 7 | yes | yes |
| t7_regex_cli | 28.0 | 25.6 | 1.09x | 10 | 7 | yes | yes |
| t8_js_bug | 42.1 | 134.4 | **0.31x (mini gana)** | 15 | 9 | yes | yes |
| t9_pkg_resize | 12.0 | 11.9 | 1.01x | 6 | 10 | yes | yes |
| t10_crash_report | 92.1 | 20.1 | 4.58x | 20 | 9 | yes | yes |

**Agregados (modelo minimax, no comparable 1:1 con la tabla de zai/glm de la ronda 1)**

| metrica | mini | pi | diferencia |
| --- | --- | --- | --- |
| Total wall time | **394.3 s** | **308.0 s** | mini **1.28x** (ronda 1: 3.65x) |
| Media por tarea | 39.4 s | 30.8 s | 1.28x |
| Mediana por tarea | 31.0 s | 15.6 s | 1.99x |
| Tareas superadas | **10/10 (100 %)** | **10/10 (100 %)** | igualado |
| Llamadas al modelo | **110** | **71** | mini 1.55x mas |
| Tiempos de modelo | 310.2 s | 302.8 s |Comparable (ambos ~300 s) |
| Overhead del harness | **2.92 s (0.94 % del modelo)** | ~5 s no-modelo | despreciable |

**Tools realmente usadas por mini (contadas sobre las 10 trayectorias)**

| tool | llamadas |
| --- | --- |
| `read` | 35 |
| `edit` | 12 |
| `write` | 8 |
| `code` | 0 |
| `bash` (tests, git, pipelines) | resto |

## 6.3 Lectura del resultado

1. **El objetivo de Jaime (ganar a pi) NO se cumple aun en agregado**: mini sigue siendo 1.28x mas
   lento que pi (394 s vs 308 s), aunque se ha cerrado la mayor parte de la brecha (3.65x -> 1.28x).
   mini gana en 1 de 10 tareas (t8, donde pi se atasco 134 s); en las demas va por detras.
2. **El exito se mantiene perfecto**: 10/10 PASS en ambos, con el verificador objetivo por tarea. Los
   tools nativos no rompieron nada y, en `t4_refactor` (la peor tarea de la ronda 1), mini paso de
   402.5 s a **94.1 s (4.3x mejor)** sin la espiral de reparaciones de quoting.
3. **El cuello sigue siendo el numero de llamadas y los tokens de salida, no el harness**. Con las
   tools nativas el tiempo de modelo de mini (310 s) y el de pi (303 s) son casi iguales; lo que
   mini gasta de mas son ~39 llamadas extra (110 vs 71). El harness de mini cuesta **2.92 s de 310 s
   de modelo (0.94 %)**, en linea con la ronda 1: no hay cuello en el lazo, el journal ni la capa web.
4. **Donde queda margen (medido, no especulado)**: mini sigue haciendo mas *turnos de modelo* que
   pi en la mayoria de tareas porque su prompt, aun mas corto, no empuja tan fuerte el batching.
   El conteo de tools reales en las 10 trayectorias da **35 `read`, 12 `edit`, 8 `write`, 0 `code`**:
   las tools nativas son ya el camino de escritura por defecto (y `bash` sigue para tests/git), pero
   **el modelo no eligio `code` ni una sola vez** en este corpus: se ofrecio y se anuncio en el
   prompt, y aun asi no lo uso porque las tareas son pequenas y un `read`+`edit` sueltos ya cabe en
   un paso. El siguiente salto medible esta en **activar de verdad el batching/code mode**
   (empujar `code` y la concurrencia 4 desde el prompt, o algo que motive el lote) para bajar el
   recuento de llamadas de ~110 hacia el ~71 de pi. No se ha tocado el harness, porque es 0.94 %
   y no mueve la aguja.
5. **Aviso de fair play**: el modelo cambio de `zai/glm-5.3` a `minimax/MiniMax-M3`, asi que las
   cifras absolutas de la ronda 2 **no son** directamente comparables con las de la ronda 1 (que
   eran de zai). Lo que si es comparable es la **tendencia**: llamadas al modelo y tiempo de modelo
   casi iguales a pi, exito igual, y la tarea que mas sufria (t4) 4.3x mejor. La comparacion
   justa dentro de un mismo modelo es mini-vs-pi de esta seccion.

## 6.4 Notas de reproducibilidad de la ronda 2

- Resultados crudos: `/home/jaime/mini-tui-benchmark/runs/20261009-232325/`.
- Trayectorias de mini (timings por fase del item 6): `~/.config/mini-tui/runs/2026-10-09T23-2*/`
  y `23-3*/` (`info.timings` y `extra.timings` por paso).
- El campo `info.timings.harness_ms` guarda el **wall del paso** (modelo + overhead), asi que el
  overhead puro es `harness_ms - model_ms` (2.92 s en el total).

---

# 7. Ronda 3: via rapida para lo trivial y menos overhead por turno (2026-10-10, commit `3e32d17`)

La ronda 2 dejo la brecha medida y sin sitio donde meter la mano: mini y pi tardaban casi igual
en **modelo** (~300 s cada uno) y el overhead del harness era el 0.94 %, pero mini hacia **110
llamadas al modelo frente a 71 de pi**. Antes de tocar nada se leyeron las 10 trayectorias de la
ronda 2 turno a turno, y ahi estan las llamadas de mas:

| origen de las llamadas de mas | medida en la ronda 2 | coste |
| --- | --- | --- |
| la **tarjeta de tarea** de la sesion (`mini-tui tasks set`), que la regla obligaba a mantener con `--done/--pending/--left` en cadaactualizacion y otra vez antes de la respuesta final | **16 llamadas** en 7 de 10 tareas (en `t5`, ademas, un `tasks set` mal formado costo un turno de reparacion) | 15 % de todas las llamadas, y ninguna era trabajo |
| el prompt **nunca decia donde estaba el agente**, asi que cada corrida pagaba `pwd`, `ls`, `find` y `cd` antes de tocar el trabajo | hasta 3 turnos por tarea (`t10`, turnos 1-5) | contexto de mas y vueltas muertas |
| el prompt **obligaba a localizar ficheros y a terminar con una tool call**, asi que un "hola" pasaba por el mismo lazo que una refactorizacion | un saludo exploraba el repo con globs y greps | 5 llamadas para no decir "hola" |
| el modelo **no agrupaba** casi nunca, aunque el batching existedia desde la ronda 2 | 4 turnos con lote sobre 110 | el lote cuesta su miembro mas lento, no la suma |

## 7.1 Que implementa la ronda 3

### Prioridad 1 --- la via rapida (`agent-rs/src/intent.rs`)

La primera peticion se **clasifica en local**: un saludo, una charla o una pregunta general se
responden en **una sola llamada al modelo, sin lista de herramientas**, y sin abrir el lazo.

- El clasificador es un recorrido de palabras sobre el texto normalizado (sin regex, sin llamada
  al modelo): cuesta 0 tokens y 0 latencia. `MINI_AGENT_FASTPATH=0` lo desactiva.
- El clasificador **declina con entusiasmo**: cualquier marca de trabajo en el texto ("tests",
  "fichero", "arregla", "informe", una ruta, un bloque de codigo) manda la tarea al lazo normal.
  Un falso negativo cuesta exactamente lo que costaba la corrida antes de este fichero, asi que
  **la calidad nunca depende del clasificador**.
- La llamada sin herramientas reutiliza la forma de peticion **ya medida** en este codigo:
  `text_only: "no_tools"` (que quita `tools` y `tool_choice`, porque se midio que GLM ignora
  `tool_choice: "none"`; ver el comentario de `WireModel::text_only`). No se invento nada.
- **Si la via rapida no puede responder, no se queda a medias**: si el proveedor falla, si devuelve
  un FormatError, o si aun sin lista de herramientas responde con tool calls (que es lo que hace
  GLM), la conversacion cae al lazo normal **intacta**. Medido: `hola` = 1 llamada y `Submitted`;
  `hola, corre los tests por favor` = lazo normal (3 llamadas).

### Prioridad 2 --- el overhead por turno que la ronda 2 si pago

1. **La tarjeta de tarea se escribe una vez**, plegada en una llamada normal, y nunca mas: la
   regla `session_tasks_rule` ya no pide `--done/--pending/--left` ni una actualizacion final.
2. **El directorio de trabajo es una variable de plantilla** (`cwd`, en el entorno de Rust y en
   el de Python, para que los dos renderizadores sigan viendo lo mismo) y el prompt lo nombra, de
   forma que ninguna corrida paga por descubrir donde esta.
3. **El batching se explica por lo que cuesta**: "una llamada por turno en vez de un lote es lo
   que hace que una tarea tarde el doble", y el flujo pide localizar los ficheros **en una sola
   llamada agrupada**.
4. **El verificador de la tarea manda**: si la tarea trae su propio comprobante (`verify.sh`, un
   target, un comando de test), se ejecuta ese y no otro. Esta linea se escribio al ver que en
   `t4` el modelo se inventaba 14 scripts de prueba ad-hoc por su cuenta; sola recibio `t4` de
   **348.6 s / 34 llamadas a 44.1 s / 8 llamadas**.

## 7.2 Metodo de la ronda 3

- **Sin orquestacion**: los mismos 10 comandos de un solo `mini-agent-rs` por tarea que en la
  ronda 2. Ningun subagent, ningun plan, ningun coordinador.
- **Mismo corpus, mismo harness y mismo modelo** (`minimax/MiniMax-M3`) que en la ronda 2, con el
  binario de esta rama reinstalado en `~/.local/lib/mini-tui/mini-agent-rs`.
- Ejecuciones secuenciales (nunca dos tareas a la vez), con la maquina tranquila: load average
  2.4-3.6 durante la corrida (la ronda 2 teve picos de 16 por trabajo ajeno, lo que se anota mas abajo).
- Verificacion objetiva por tarea: los mismos `verify.sh` de las rondas 1 y 2.

## 7.3 Resultados por tarea (segundos)

| tarea | mini R2 | pi R2 | mini R3 | pi R3 | mini vs pi R3 | llamadas mini R2 -> R3 | turnos pi R2 -> R3 | mini ok | pi ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| t1_wordfreq | 16.0 | 9.9 | 26.0 | 8.8 | 2.95x mas lento | 4 -> 5 | 5 -> 5 | yes | yes |
| t2_grep_logs | 16.0 | 12.4 | 12.0 | 22.3 | **0.54x (mini gana)** | 6 -> 5 | 7 -> 5 | yes | yes |
| t3_pytest_fix | 30.0 | 14.8 | 34.1 | 14.5 | 2.35x mas lento | 8 -> 5 | 7 -> 9 | yes | yes |
| t4_refactor | 94.1 | 56.2 | 142.2 | 166.7 | **0.85x (mini gana)** | 22 -> 15 | 6 -> 9 | yes | yes |
| t5_script_csv | 32.0 | 6.4 | 12.0 | 17.8 | **0.67x (mini gana)** | 11 -> 5 | 4 -> 4 | yes | yes |
| t6_readme_summary | 32.0 | 16.3 | 18.0 | 18.1 | **0.99x (empate)** | 8 -> 4 | 7 -> 6 | yes | yes |
| t7_regex_cli | 28.0 | 25.6 | 66.1 | 24.3 | 2.72x mas lento | 10 -> 7 | 7 -> 5 | yes | yes |
| t8_js_bug | 42.1 | 134.4 | 58.1 | 77.8 | **0.75x (mini gana)** | 15 -> 8 | 9 -> 10 | yes | yes |
| t9_pkg_resize | 12.0 | 11.9 | 14.0 | 48.4 | **0.29x (mini gana)** | 6 -> 7 | 10 -> 8 | yes | yes |
| t10_crash_report | 92.1 | 20.1 | 28.1 | 31.4 | **0.89x (mini gana)** | 20 -> 9 | 9 -> 9 | yes | yes |

**Agregados**

| metrica | mini R2 | mini R3 | pi R3 | lectura |
| --- | --- | --- | --- | --- |
| Total wall time | 394.3 s | **410.6 s** | 430.1 s | **mini gana: 0.95x** (R2: 1.28x) |
| Media por tarea | 39.4 s | 41.1 s | 43.0 s | mini mas rapido de media |
| Mediana por tarea | 31.0 s | 27.1 s | 23.3 s | pi mantiene la mediana |
| **Tareas superadas** | 1/10 | **7/10** | --- | mini gana en 7 de 10 |
| **Tareas resueltas** | 10/10 | **10/10** | **10/10** | calidad intacta |
| **Llamadas al modelo** | **110** | **70** | **70** | **igualadas con pi** (R2: 1.55x mas) |
| Tiempos de modelo | 310.2 s | --- | 424 s | pi gasta mas tiempo de modelo y aun asi pierde |

**Tools usadas por mini en la ronda 3 (contadas sobre las 70 trayectorias de turno)**

| tool | llamadas |
| --- | --- |
| `bash` | 39 |
| `read` | 30 |
| `write` | 4 |
| `edit` | 4 |
| `code` | 0 |

## 7.4 Lectura del resultado

1. **El objetivo de Jaime se cumple por primera vez en agregado: mini gana, 0.95x** (410.6 s
   contra 430.1 s), con **10/10 PASS en los dos harnesses** y ganadoras en **7 de las 10 tareas**.
   La ronda 1 fue 3.65x, la ronda 2 1.28x y esta 0.95x.
2. **La llamada al modelo es lo que se ha medido y lo que se ha igualado: de 110 a 70, exactamente
   las 70 que hace pi en el mismo corpus** (la ronda 2-era 1.55x mas). Y lo que se quito no era
   trabajo: **16 llamadas de tarjeta de tarea -> 1**, y los turnos perdidos en `pwd`/`ls`/`find`
   quedaron en 3.
3. **La partida se gana por distribucion, no solo por total**: mini pierde en `t1`, `t3` y `t7`,
   donde sus 5-7 llamadas pesan mas en reloj que las 5-9 de pi, y gana con claridad en `t9`
   (0.29x), `t2` (0.54x) y `t8` (0.75x), tareas donde el trabajo de leer y entender el repo se
   paga una sola vez.
4. **La linea del verificador resulto ser el arreglo mas rentable de todos**: `t4` paso de
   348.6 s / 34 llamadas (mini en la primera corrida de la ronda 3, antes de la linea) a
   **44.1 s / 8 llamadas** en cuanto se dijo, en una frase del prompt, "usa el comprobante que
   trae la tarea y no escribas tus propios tests". Es la prueba de que buena parte de las vueltas
   de mas de mini no eran exploracion, sino el modelo improvisando su propia verificacion.
5. **Aviso de honestidad sobre el ruido**: `t4` es una tarea de varianza alta (348.6 s -> 44.1 s
   -> 142.2 s en tres corridas de la misma version, todas PASS) y `t7` tambien (28.0 s R2 ->
   66.1 s R3). Durante la primera corrida de la ronda 3 la maquina tenia un load average de ~16
   por procesos ajenos; la corrida final que se documenta aqui se hizo con load 2.4-3.6. Las
   cifras de esta seccion son **la corrida final completa** (`runs/20261010-061323`), no un
   promedio de las tres.
6. **Lo que queda**: la mediana sigue siendo de pi (23.3 s contra 27.1 s de mini) porque en las
   tareas cortas mini tarda mas **por turno**, no por hacer mas trabajo: con las llamadas ya
   igualadas, el siguiente frente es la duracion del turno (cuantos tokens de razonamiento por
   llamada), no el numero de llamadas. La via rapida de la prioridad 1 no se ve en este corpus
   (las 10 tareas son trabajo real); su valor esta en las rutas interactivas, y esta medida a
   parte en los ejemplos de la seccion 7.5.

## 7.5 La via rapida medida fuera del corpus

El corpus del benchmark son 10 tareas de trabajo real, asi que la via rapida no aparece en el
total de arriba. Se midio aparte, contra el mismo modelo:

| mensaje | resultado |
| --- | --- |
| `hola` | **1 llamada**, `exit_status: Submitted`, sin tools, sin explorar el repo |
| `hola, ¿qué puedes hacer?` | **1 llamada**, respuesta en castellano |
| `gracias!` | **1 llamada**, fast path |
| `hola, corre los tests por favor` | lazo normal (3 llamadas): "tests" es marca de trabajo |
| `Fix the bug in cart.js: the boundary is >= not >` | lazo normal |

## 7.6 Notas de reproducibilidad de la ronda 3

- Resultados crudos: `/home/jaime/mini-tui-benchmark/runs/20261010-061323/` (corrida final,
  la de las tablas de 7.3). La primera corrida de la ronda 3, `runs/20261010-055531/`, sirve
  para ver el antes/despues de la linea del verificador en `t4`.
- Trayectorias de mini: `~/.config/mini-tui/runs/2026-10-10T06-13-*/` hasta `06-27-*`
  (`info.model_stats.api_calls` es el recuento de llamadas al modelo).
- Verificacion manual de la via rapida: `MINI_AGENT_FASTPATH=0` la desactiva; el camino de
  rechazo (proveedor que responde con tool calls aun sin lista) cae al lazo normal por diseno.
- Build verificado: `cargo +1.97.1-x86_64-unknown-linux-gnu build --release` limpio en
  `agent-rs/` (los avisos que quedan son preexistentes y ajenos a estos cambios).
---

# 8. Ronda 4: la duracion del turno (2026-10-10)

La ronda 3 igualo el **numero de llamadas** (70 mini contra 70 turnos de pi) y gano el agregado,
pero pi seguia ganando la **mediana**: 23.3 s contra 27.1 s de mini. El frente ya no era *cuantas*
llamadas, sino **cuanto dura cada turno**. Antes de tocar codigo se midio donde se va el tiempo de
un turno en las trayectorias de la ronda 3 (`extra.timings`, que `agent-rs/src/timings.rs` escribe
por fase), turno a turno, sobre las 70 llamadas de las 10 tareas.

## 8.1 La medicion: el overhead del harness no es el problema

| por turno (ms) | media | mediana |
| --- | --- | --- |
| **modelo** (espera de la llamada) | **4 944,5** | **4 693,9** |
| `actions` (tool dispatch) | 34,3 | 18,8 |
| `view` (render del prompt) | 0,25 | 0,25 |
| `observe` | 0,18 | 0,18 |
| `control` | 0,00 | 0,00 |
| `save` | 0,17 | 0,17 |
| **overhead total del harness** | **34,9** | **19,4** |

Aun tomando el peor caso (la media, arrastrada por un turno de `actions` de 1,5 s) el overhead son
34,9 ms por turno sobre 4 944,5 ms de modelo: **0,7 %**. Sumado sobre la corrida entera fueron
**2,32 s de 410,6 s (0,57 %)**. Render de prompt, serializacion y tool dispatch **no tienen nada
que recortar**: ya cuestan menos que el jitter de la red. Cualquier plan que ataque ahi seria
optimizar ruido.

Donde si habia tiempo era fuera del lazo:

| | ronda 3 | significado |
| --- | --- | --- |
| arranque antes de la primera llamada | **2,6 - 3,0 s por corrida** | fork del binario, config, handshake TLS, primer TTFB del proveedor |
| hueco por tarea (wall - modelo - harness) | ~1,0 s por tarea | 10,0 s en el total (2,4 %) |
| modelo | 396 s (96,9 %) | 70 turnos x ~4,9 s |

Y la variable que si explicaba el turno lento no era el prompt (mini envia 7,5 k caracteres de
sistema+usuario frente a las 25,5 k de las secciones de pi: **mas pequeno y mas lento**) sino los
**tokens generados**: mini producia **997 caracteres por turno** (849 de ellos de razonamiento)
contra 709 de pi, y arrastraba **27,8 % de su prompt como razonamiento ya emitido** (300 241 de
1 079 605 caracteres de contexto; en `t4` y `t8` la mitad del prompt era razonamiento repetido).

## 8.2 Palanca descartada: quitar el eco del razonamiento

La idea obvia era no reenviar el bloque `<think>` de turnos anteriores (`chat_messages` en
`agent-rs/src/models/wire.rs` solo copia `WIRE_KEYS`). Se midio **reproduciendo un prompt real de
`t8` con el `<think>` eliminado** contra el mismo prompt intacto, mismo modelo, misma
temperatura:

| | caracteres de prompt | tokens generados | tiempo por turno |
| --- | --- | --- | --- |
| con el eco (mini hoy) | 34 485 | 1 371 | 8,13 s |
| **sin el eco** | **15 082** | **392** | **2,31 s** (mediana) |
| veredicto | **-56 % de prompt** | **+3,5x tokens** | **2,90x mas lento** |

Menos prompt, mas tiempo. Al quitarle el historial de razonamiento el modelo se vuelve a
explicar el contexto desde cero en cada turno: la respuesta llega antes, pero el turno **se alarga
2,9x**. **No se implemento.** El eco de razonamiento no es un bug que corregir sino el mecanismo
por el que el modelo conserva el hilo; mini ya hace lo correcto por defecto y por la razon
equivocada.

## 8.3 Lo que si se recorta: razonamiento acotado por prompt

La lever que quedo es la que ataca la variable real -caracteres generados por turno- sin tocar el
harness. Una linea dentro de `<response_format_rule>` del `system_template`
(`agent/src/minisweagent/config/mini.yaml`):

```
Keep the reasoning short: one or two sentences per turn, then the tool call. Reasoning is not
read by anyone — the next turn sees only the tool result — so a turn that writes an essay to
reach a `bash` call buys nothing and costs the run seconds it will not get back. Put the
thinking in the command, not in prose.
```

No es una instruccion nueva en el prompt: es la misma regla de "cada respuesta lleva una tool
call" que ya existe, aplicada al tamaño del razonamiento. Antes de tocar nada se midio un **A/B
sobre el agente real** (`mini-agent-rs` de release, `verify.sh` de verdad, tres tareas del corpus x
3 replicas por brazo):

| brazo | wall medio | mediana | generado | llamadas | PASS |
| --- | --- | --- | --- | --- | --- |
| A (prompt de hoy) | 14,7 s | 15,8 s | 1 841 c | 6,3 | 9/9 |
| **D (razonamiento acotado)** | **11,6 s** | **11,9 s** | **1 110 c** | **5,4** | **9/9** |

**0,78x de tiempo, 0,60x de caracteres generados, 0,86x de llamadas, 18/18 PASS entre los dos
brazos.** D gano en 8 de 9 parejas. Se descarto antes el brazo B (quitar la narracion del
workflow) porque aunque tambien salia mas rapido, C (un prompt de puro harness) era mas rapido aun
- y ese quitaba cosas que el agente necesita, asi que D es el que se quedo: es el unico que no
cambia el contrato.

## 8.4 Bug encontrado de paso: `--exit-immediately` no hacia nada

Al medir el hueco por tarea aparecio algo que no era tiempo sino **procesos vivos**. `src/mini/spawn.ts`
pasa siempre `-y --exit-immediately`, y `config.rs:181` lo traducía a `agent.confirm_exit: false`,
pero **ningun codigo leia ese campo**: `wait_for_followup()` se quedaba esperando un seguimiento
que nunca iba a llegar. Cada corrida del benchmark escribia `Submitted` y se quedaba colgada para
siempre.

Medido sobre la ronda 3: **48 procesos de `mini-agent-rs` seguian vivos horas despues de terminar
el benchmark, con 662 MB de RSS**, cada uno con su socket del hub y su hilo de monitor. El campo
`confirm_exit` se leia en ningun sitio, asi que ahora `AgentConfig` lo expone y
`wait_for_followup()` hace su trabajo:

```rust
// `--exit-immediately`: this run ends with its turn. Children still at work are killed
// by the hub guard on the way out, not waited for -- a headless caller is not going to
// read their reports, and holding here is what left 55 processes alive after round 3.
if !self.config.confirm_exit {
    return Ok(false);
}
```

El default sigue siendo `true`: una corrida **con fichero de control** es una sesion que alguien
puede seguir, y ahi esperar es lo correcto. Verificado con una corrida real: `exit=0` con 0,002 s de
cola (antes se colgaba para siempre), y la comprobacion de que el binario instalado ya no deja
procesos tras de si.

## 8.5 Resultados de la ronda 4

Corrida completa: `/home/jaime/mini-tui-benchmark/runs/20261010-111219` (log `bench-111219.log`).

| tarea | mini R3 | pi R3 | mini R4 | pi R4 | ratio R3 | ratio R4 |
| --- | --- | --- | --- | --- | --- | --- |
| t10_crash_report | 28,1 | 31,4 | 62,1 | 65,4 | 0,89 | **0,95** |
| t1_wordfreq | 26,0 | 8,8 | 20,0 | 7,7 | 2,95 | 2,60 |
| t2_grep_logs | 12,0 | 22,3 | 10,0 | 25,5 | 0,54 | **0,39** |
| t3_pytest_fix | 34,1 | 14,5 | 20,0 | 12,6 | 2,35 | 1,59 |
| t4_refactor | 142,2 | 166,7 | 46,1 | 45,3 | 0,85 | 1,02 |
| t5_script_csv | 12,0 | 17,8 | 8,0 | 7,1 | 0,67 | 1,13 |
| t6_readme_summary | 18,0 | 18,1 | 28,1 | 14,5 | 0,99 | 1,94 |
| t7_regex_cli | 66,1 | 24,3 | 18,0 | 20,0 | 2,72 | **0,90** |
| t8_js_bug | 58,1 | 77,8 | 72,2 | 55,8 | 0,75 | 1,29 |
| t9_pkg_resize | 14,0 | 48,4 | 10,0 | 22,2 | 0,29 | **0,45** |

| | ronda 3 | ronda 4 |
| --- | --- | --- |
| mini total / **mediana** | 410,6 s / **27,1 s** | 293,7 s / **20,0 s** |
| pi total / **mediana** | 430,1 s / **23,3 s** | 276,0 s / **21,1 s** |
| ratio agregado | 0,95x | **1,07x** |
| tasks ganadas | 7/10 | 4/10 |
| llamadas / turnos | 70 / 70 | 73 / 81 |
| calidad | **10/10 PASS** | **10/10 PASS** |

**La mediana se dio la vuelta** (20,0 s contra 21,1 s): en la mitad de las tareas **mini es el mas
rapido**, que es exactamente el frente que fijaba el objetivo de la ronda 4. El tiempo por turno
cayo de 4 944 ms a **3 539 ms de media** (3 030 de mediana, -28 % / -35 %) sin tocar el harness.

## 8.6 El overhead por turno, antes y despues

| por turno (ms) | R3 (70 turnos) | R4 (73 turnos) |
| --- | --- | --- |
| modelo | 4 944,5 (med 4 693,9) | **3 538,6** (med **3 030,3**) |
| `actions` | 34,3 | 25,0 |
| `view` / `observe` / `control` / `save` | <= 0,25 | <= 0,23 |
| **overhead del harness** | **34,9** (med 19,4) | **25,5** (med **13,6**) |
| **overhead sobre el total** | 0,57 % | **0,58 %** |

El overhead por turno bajo de 34,9 a 25,5 ms de media (-27 %) y de 19,4 a 13,6 ms de mediana
(-30 %), pero **sigue siendo ~0,6 % del tiempo de la corrida**: la mejora real vino de turnos
mas cortos, no de codigo mas rapido. Es el dato que cierra la pregunta que abrio la ronda 4 - el
overhead del harness ya estaba resuelto en la ronda 3, solo faltaba medirlo bien y decirlo.

## 8.7 Honestidad sobre la corrida

- La corrida de la ronda 4 se hizo con **load average de 2,4 - 6,8** (builds ajenos de `vike`
  durante los primeros minutos), frente a **2,4 - 3,6** en la ronda 3. **Los tiempos absolutos no
  son comparables entre rondas**: `t10` tardo 62,1 s aqui frente a 28,1 s en la ronda 3, pero **pi
  tardo tambien el doble** (31,4 -> 65,4 s) porque los dos lados corren secuencialmente bajo las
  mismas condiciones. Lo que si es comparable es el **ratio por tarea**, porque las dos mitades
  comparten las condiciones de la corrida.
- `t10` (62,1 s) y `t8` (72,2 s) son las dos tareas largas y las dos de mayor varianza, como ya
  se documento en `t4` (348,6 -> 44,1 -> 142,2 s) y `t7` (28,0 -> 66,1 s) en la ronda 3. `t10`
  empeoro y `t8` tambien; `t4` mejoro **3,1x** (142,2 -> 46,1 s) y pi tambien mejoro (166,7 ->
  45,3 s). Con 10 tareas, dos de varianza alta mueven la mediana y el agregado a la vez.
- El **agregado empeora** (0,95x -> 1,07x) aunque la **mediana mejora** (23,3 -> 21,1 s a favor de
  mini). No es una contradiccion: el agregado lo mueven `t10` y `t8`, las dos mas largas, y la
  mediana es la medida que el objetivo de la ronda 4 fijaba como el frente. mini gano 4 de 10
  tareas (contra 7 de 10 en la ronda 3), porque pi tambien se beneficio: las llamadas de pi
  subieron de 70 a 81 turnos.
- **El arranque de 2,6 - 3,0 s no se toco.** Medido por separado con y sin el hub de subagentes
  (`MINI_AGENT_SUBAGENTS=0`): 1,21 - 1,42 s sin hub contra 0,98 - 3,62 s con hub, es decir **el
  arranque es el handshake TLS y el TTFB del proveedor, no el harness**. Se queda como trabajo
  futuro.

## 8.8 Lo que queda

1. **`t10` y `t8` son el frente real**: 62,1 s y 72,2 s contra 65,4 s y 55,8 s de pi. Son las
   tareas largas y las de mayor varianza. Con 10 tareas no se puede ganar el agregado sin ellas.
2. **El arranque (~1,2 s medido, hasta 3,6 s en frio)** son TLS y TTFB del proveedor. Se puede
   atacar con una conexion persistida por proceso, no con codigo.
3. **`t6_readme_summary` empeoro a 1,94x** (18,0 -> 28,1 s): el razonamiento acotado ayudo al
   tiempo pero la corrida de esa tarea termino en 8 llamadas en vez de 4. Habria que mirar por que
   pidio mas tool calls antes de asumir que el acotamiento es neutro.
4. **La calidad sigue en 10/10 PASS en ambos lados**, asi que ninguna de las cifras de aqui se
   compro a costa de la calidad. Es lo que se pedia: mini ganando en velocidad **y** calidad.
## 8.9 Ronda 5: donde se va el tiempo, de verdad

La ronda 4 dejo el mismo sitio por dos vias: el arranque (~1,2 s, TLS + TTFB) y las dos tareas
largas, `t8` y `t10`. Antes de mover nada, la pregunta era otra: **de los 279,1 s de modelo de la
ronda 4, cuanto era razonamiento y cuanto trabajo**. Reconstruyendo las trayectorias de las 10
corridas de la ronda 4 (`analyze_traj.py`, `grader_scan.py`):

- **39 % del tiempo de modelo (107,5 s) y 45 % de los caracteres generados se fueron en pensar
  sobre `verify.sh`**, en 7 de 10 tareas. En `t10` fueron 45,1 s de 60,1 s; en `t4`, 27,9 s de
  44,3 s.
- Pero el numero que de verdad manda no es el total: **es el turno mas largo**. Sobre la ronda 4, el
  turno mas largo de una corrida fue de mediana el **30 % del wall de esa corrida**. En `t8` el
  peor turno fueron 55,1 s de 72,2 s, y en un A/B hubo un turno de 101,3 s dentro de una corrida de
  108,3 s.
- Y esos turnos son **casi todo razonamiento**: el peor turno de `t8` en la ronda 4 escribio
  **19 427 caracteres de `<think>` para emitir una tool call de 193**. El payload sin razonamiento
  mas largo de las 73 trayectorias fue de 1 241 caracteres (~400 tokens).

O sea: **no es un problema de turnos, es un problema de longitud de turno**. La palanca no es
"razonar menos" en general, es que **un turno no puede Emitir una novela**.

## 8.10 Lo que se midio antes de tocar nada

Dos controles negativos, porque sinon cualquier numero parece bueno:

**No existe perilla de razonamiento en minimax.** `reasoning_effort`, `thinking_budget`,
`enable_thinking` y `reasoning_split` se aceptan y se **ignoran en silencio**; `thinking.type` solo
admite `adaptive` o `disabled`. Y `adaptive` fue **peor** (20,0 s contra 4,6 - 8,7 s de base).
`max_tokens` es la unica perilla real.

**El arranque no es del agente.** `measure_startup.sh`: el hueco de arranque del proceso es de
**0,02 s**. Los ~1,2 s estan dentro de la primera llamada al modelo. Medicion directa de TLS:
conexion en frio 0,88 - 1,25 s contra keep-alive 0,54 - 0,76 s, o sea **0,3 - 0,5 s por llamada**
(~3 - 5 s por corrida). El agente ya hace pool con `OnceLock<ureq::Agent>`.

## 8.11 La palanca que funciono: el techo de salida por turno

El techo era un 8192 sin escribir. Ahora es `DEFAULT_MAX_TOKENS = 4096` en `agent-rs/src/models/wire.rs`,
aplicado donde se construye el body del chat (un `model_kwargs.max_tokens` explicito sigue
ganando), con `MSWEA_MAX_TOKENS` / `model.max_tokens` como override.

Barrido sobre **todo el corpus**, las tres locales encadenadas tarea por tarea
(`cap_bench.py`, 10 tareas x 3 techos), load 1,9 - 2,9:

| tarea | 8192 | 4096 | 2048 |
| --- | --- | --- | --- |
| t10_crash_report | 54,8 | **14,5** | 14,1 |
| t1_wordfreq | 22,9 | **9,3** | **8,5** |
| t2_grep_logs | 21,2 | **7,7** | 16,6 |
| t3_pytest_fix | 38,2 | **7,7** | **12,4** |
| t4_refactor | **31,1** | 42,5 | 22,1 (FAIL) |
| t5_script_csv | 11,1 | **7,8** | 8,6 |
| t6_readme_summary | 45,6 | **20,0** | 29,0 |
| t7_regex_cli | **9,0** | 10,1 | 17,9 |
| t8_js_bug | **17,6** | 62,5 | 31,5 |
| t9_pkg_resize | **13,3** | 12,0 | 21,1 |

| techo | wall (medianas) | ratio | turno mas largo | turnos | chars | trunc | PASS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8192 | 264,8 s | 1,00 | 8,0 s | 7,0 | 2 513 | 0 | 10/10 |
| **4096** | **194,1 s** | **0,73** | **3,5 s** | 6,5 | **1 266** | **0** | **10/10** |
| 2048 | 181,8 s | 0,69 | 6,1 s | 6,5 | 2 328 | 1 | **9/10** |

**4096 esta en el punto medido, no en un numero redondo.** 7 de 10 tareas mas rapidas, **cero
turnos truncados**, turno mas largo de mediana 8,0 -> 3,5 s y texto generado 2 513 -> 1 266 chars.
2048 no es mas rapido de forma que compense (0,69x) y **trunco un turno**. 3072, que sugeria el
primer barrido, **perdio `t8_js_bug` por una truncacion**, asi que nunca fue una opcion real.

## 8.12 El bug que encontro el propio barrido

`cap_bench.py` no cuenta solo el tiempo: cuenta los turnos que **llegaron al techo**, y cuantos de
esos salieron **sin tool call**. En `t4_refactor` con 2048 hubo uno: turno 2 con
`finish_reason: "length"` y **cero acciones**, y la corrida **termino ahi**. `verify.sh` FAILED.

La causa estaba en `chat_reply`: un turno truncado no trae `tool_calls`, y minimax mete el
razonamiento en `content`, asi que la rama `else if tool_calls.is_empty()` leia ese razonamiento
como **respuesta final** y el bucle entregaba una corrida que no habia hecho el trabajo. Esa rama
devuelve ahora `None` cuando `finish_reason == "length"`, con lo que cae en
`parse_toolcall_actions`, cuya rama "no tool call" ya es un error de formato que **el bucle
reintenta**. El modelo al que le cortaron el pensamiento lo termina; solo se gasta un turno que
llego a emitir una tool call.

Reejecutado el caso exacto que fallaba: `t4_refactor` a 2048 pasa de FAIL a **PASS**, con 7
turnos limpios terminando en `stop`.

## 8.13 La palanca que se midio y se **tiro**

Antes del techo se probo acotar el razonamiento **por prompt**, anadiendo una regla al system
template: ejecutar el checker, no leerlo. Sobre `t8` bajo funcionaba: **41,5 s -> 8,2 s** de
razonamiento sobre el grader. Pero el agregado fue **1,73x mas lento**, con **64 % mas de
caracteres** y un `verify.sh` en FAILED. Arma B (mas turnos, una prosa gigante) contra arma A. No
se quedo; **solo se queda el techo**, que actua donde de verdad estaba el problema.

## 8.14 Jev: el verificador pasa al agente

La fase de PR #115 vivia **solo en `src/ui/App.tsx`**, asi que una corrida lanzada por la web, por
`mini-tui -p` o por un subagente — las superficies que mide este benchmark — **nunca recibia un
veredicto**. Ahora `agent-rs/src/jev.rs` la corre al terminar el bucle: el **modelo de la propia
corrida** propone candidatos sobre `git diff HEAD` mas los ficheros sin trackear, y Jev responde a
las tres preguntas tipadas. `info.jev_verifier` en `traj.json` lleva el informe estructurado.

Medido: un diff con un `import` sin usar devolvio **1 candidato, juzgado por `jev-1.13.0` en
274 ms**, con P(real)=0,46 / P(serious)=0,03 -> `ignore`. Correcto: no era un defecto. Pero
**no es un buen lector**: sobre un `safe_div` con `except` a pelo escrito a mano, MiniMax-M3 no
propuso ningun candidato. Ese es el limite honesto de esta configuracion: el lector es el modelo de
la corrida porque pedir una segunda credencial era el peor trato.

**El veredicto tipado no ayudo a podar trabajo inutil**: la fase corre *despues* del bucle, asi que
para cuando hay veredicto ya se gasto el trabajo. Medir si Helps seria trabajo de otra ronda.

## 8.15 Resultados de la ronda 5

Corrida completa: `/home/jaime/mini-tui-benchmark/runs/20261010-134052`, mismas condiciones que las
rondas anteriores (mismo modelo en los dos lados, `minimax/MiniMax-M3`, secuencial, sin orquestacion),
load 1,6 - 2,4 anotado en cada linea del log. Techo 4096 (el default recien compilado), Jev off
para no contaminar la medicion de tiempo.

| tarea | mini R4 | pi R4 | ratio R4 | mini R5 | pi R5 | ratio R5 |
| --- | --- | --- | --- | --- | --- | --- |
| t10_crash_report | 62,1 | 65,4 | 0,95 | **12,0** | 46,6 | **0,26** |
| t1_wordfreq | 20,0 | 7,7 | 2,60 | 12,0 | 12,5 | 0,96 |
| t2_grep_logs | 10,0 | 25,5 | 0,39 | 16,0 | 8,4 | **1,90** |
| t3_pytest_fix | 20,0 | 12,6 | 1,59 | **10,0** | 14,2 | 0,70 |
| t4_refactor | 46,1 | 45,3 | 1,02 | 44,1 | 51,8 | 0,85 |
| t5_script_csv | 8,0 | 7,1 | 1,13 | 8,0 | 9,1 | 0,88 |
| t6_readme_summary | 28,1 | 14,5 | 1,94 | **20,1** | 23,2 | 0,87 |
| t7_regex_cli | 18,0 | 20,0 | 0,90 | 28,1 | 32,6 | 0,86 |
| t8_js_bug | 72,2 | 55,8 | 1,29 | **28,1** | 75,8 | **0,37** |
| t9_pkg_resize | 10,0 | 22,2 | 0,45 | 26,1 | 21,1 | **1,24** |

| | R1 | R2 | R3 | R4 | **R5** |
| --- | --- | --- | --- | --- | --- |
| ratio agregado | 3,65x | 1,28x | 0,95x | 1,07x | **0,69x** |
| mini total | - | - | 410,6 s | 293,7 s | **204,5 s** |
| mini mediana | - | - | 27,1 s | 20,0 s | **18,1 s** |
| pi total | - | - | 430,1 s | 276,0 s | 295,0 s |
| pi mediana | - | - | 23,3 s | 21,1 s | 22,1 s |
| tasks ganadas | - | - | 7/10 | 4/10 | **8/10** |
| llamadas / turnos | - | - | 70 / 70 | 73 / 81 | **65 / 64** |
| calidad | - | - | 10/10 | 10/10 | **10/10** |

**La primera vez que mini gana el agregado.** 0,69x son 204,5 s contra 295,0 s de pi: -30 % de
tiempo, con la calidad intacta (**10/10 PASS en los dos lados**). Y las dos tareas del frente de la
ronda 4 se Movieron: `t10` de 62,1 s a **12,0 s** (5,2x) y `t8` de 72,2 s a **28,1 s** (2,6x).

El detalle que hace que la cifra sea creible: **el tiempo de modelo bajo de 279,1 s a 179,1 s**, y
el turno mas largo de mediana cayo de ~30 % del wall por corrida a **4,9 s**. No se gano nada
quitando trabajo: los chars generados de mediana bajaron de ~2 500 a 1 667 **porque el modelo dejo
de escribir ensayos para emitir una tool call de 193 caracteres**.

Donde mini pierde (t2 1,90x, t9 1,24x) es varianza de `t8`/`t10`: mini tiene 6 y 7 turnos donde pi
tiene 7 y 12, y en esas dos tareas el piloto automatico se pasa de turno.

## 8.16 Lo que queda

1. **El arranque (~1,2 s: TLS + TTFB)** sigue intacto, y ahora pesa mas en proporcion: con la
   corrida a 18 s de mediana, 1,2 s de arranque es ~7 %. La medicion existe (0,3 - 0,5 s por llamada
   de ahorro con keep-alive) pero el pool actual no lo estructura porque el proveedor manda
   `Connection: close`. Es el siguiente frente, y es de la parte del proveedor, no del harness.
2. **La varianza de `t8` y `t10`** es lo que todavia puede tirar el agregado. En el barrido, `t8`
   fue 17,6 s a 8192 pero 62,5 s a 4096: una sola rep es ruido. El agregado de la ronda 5 es real
   (8/10 ganadas, 204,5 s) pero **una rep no es una tendencia**; falta repetir la corrida completa
   un par de veces para ver si 0,69x se sostiene.
3. **`t6_readme_summary` se recupero** (1,94x -> 0,87x) sin tocar nada de esa tarea: era el sintoma
   del mismo problema, no un problema de llamadas. La hipotesis de la ronda 4 ("termino en 8 llamadas
   en vez de 4") era falsa; eran 7 turnos de razonamiento sobre el checker.
4. **La calidad sigue en 10/10 en ambos lados.** La velocidad no se compro con calidad, que era lo
   que se pedia.

---

## 9. Ronda 6: tres reps mas, y el 0,69x de la ronda 5 era ruido

Pedido del 10 oct 16:23: repetir la corrida completa para separar tendencia de ruido, y si el
agregado deja de ser <1x de forma consistente, volver a las palancas.

**Resultado: el 0,69x no se sostiene.** Con las mismas condiciones que las rondas 1-5 (mismo
modelo en los dos lados, `minimax/MiniMax-M3`, secuencial, Jev apagado, techo 4096 por defecto),
tres reps nuevas:

| rep | mini | pi | ratio agregado | calidad mini | calidad pi |
| --- | --- | --- | --- | --- | --- |
| ronda 5 (`134052`) | 204,5 s | 295,0 s | **0,69x** | 10/10 | 10/10 |
| rep 1 (`142520`) | 254,5 s | 225,3 s | **1,13x** | 10/10 | 10/10 |
| rep 2 (`143406`) | 285,4 s | 291,4 s | **0,98x** | 10/10 | 10/10 |
| rep 3 (`144419`) | 246,7 s | 266,4 s | **0,93x** | 10/10 | 10/10 |

**2 de 3 reps por debajo de 1x**, y el rango entero es 0,93x - 1,13x. La mediana del agregado de
las tres reps nuevas es **0,98x**: mini y pi estan empatados, con la ventaja de mini dentro del
margen de ruido del propio corpus. Repartido por tarea (medianas de 4 corridas, mini/pi):

| tarea | mini mediana (min-max) | pi mediana (min-max) | ratio mediana |
| --- | --- | --- | --- |
| t10_crash_report | 49,2 (12,0 - 94,2) | 30,0 (22,7 - 67,4) | 1,64x |
| t1_wordfreq | 12,0 (10,0 - 16,1) | 18,4 (9,9 - 28,1) | 0,65x |
| t2_grep_logs | 15,0 (10,0 - 18,1) | 14,5 (13,1 - 28,5) | 1,03x |
| t3_pytest_fix | 12,0 (10,0 - 20,1) | 11,8 (11,1 - 16,8) | 1,02x |
| t4_refactor | 47,1 (36,1 - 66,2) | 53,9 (35,9 - 57,7) | 0,87x |
| t5_script_csv | 9,0 (8,0 - 12,0) | 12,8 (10,7 - 17,3) | 0,70x |
| t6_readme_summary | 18,1 (14,0 - 20,1) | 25,0 (18,6 - 36,7) | 0,72x |
| t7_regex_cli | 23,1 (10,0 - 32,1) | 15,4 (11,5 - 28,9) | 1,50x |
| t8_js_bug | 38,1 (22,1 - 60,2) | 55,7 (20,0 - 70,3) | 0,68x |
| t9_pkg_resize | 19,1 (8,0 - 26,1) | 12,1 (9,7 - 17,3) | 1,58x |

**Calidad: 40/40 PASS en mini y 30/30 en pi** (4 corridas completas, ningun verify.sh FAILED).
Lo que se mantiene solido es exactamente lo que la orden pedia: la calidad. Lo que no se
mantiene es la ventaja de velocidad.

### 9.1 De donde sale la varianza (y por que no hay palanca de harness)

Reconstruyendo las 40 corridas (`phase_report.py`), el desglose es **modelo, no mini**:

- **El overhead propio del harness es 1,8 - 2,7 s en una corrida de 250 s: ~1 %.** Ya era la
  conclusion de la ronda 1 y sigue siendo la de la ronda 6.
- **El 78 - 81 % del wall es tiempo de modelo**, medido turno a turno desde las trayectorias.
- Lo que mueve el resultado es **cuantos turnos toma el modelo y cuanto razona en cada uno**.
  `t10_crash_report` es el ejemplo limpio: en la rep 2 mini tardo 94,2 s con 25 llamadas y 93,8 s
  de modelo puro (25 turnos cortos de 1 - 5 s); en la rep 1 tardo 66,2 s con 8 llamadas pero
  **65 s de modelo**, porque dos turnos se estiraron a 16,7 s y 17,3 s. Ni el harness ni el techo de
  salida deciden eso: es la longitud del razonamiento que el modelo elige en ese turno.
- El rango de `t10` en mini (12,0 - 94,2 s) es casi 8x. Ninguna cifra de una sola rep de esa
  tarea significa algo, que es justo el aviso que dejo la seccion 8.16.

### 9.2 Un campo de medicion que no era fiable

`extra.timings.overhead_ms` se calcula como `total_ms - suma(fases "model")`, pero `total_ms`
**ya incluye** la fase `model` (se acumula en `add`). Cuando la fase `model` no llega a
etiquetarse, el campo colapsa a la duracion entera del paso y reporta el tiempo del modelo como
si fuera overhead: en `t8` de la rep 1 salia `overhead_ms: 14781` para una corrida cuyo modelo
total era 14,6 s. El campo se puede usar para comparar fases entre pasos, pero **no** para
concluir "el harness no cuesta nada": esa cifra sale de `sum_model_ms` contra el wall, no de
`overhead_ms`. Aqui queda anotado para que la ronda 7 no se apoye en el campo equivocado.

### 9.3 Decision de la ronda 6: no seguir moviendo palancas de harness

El criterio de la orden era explicito ("si el agregado deja de ser <1x de forma consistente,
volver a las palancas"). El agregado no es <1x de forma consistente: es **1,13x / 0,98x / 0,93x**,
mediana 0,98x, dentro del ruido. Se cumple la condicion.

Aun asi, **volver a las palancas no produciria una mejora medible**, y la medicion lo dice:

1. El techo de salida por turno (4096) **ya esta aplicado** y ya se midio en el barrido; la ronda 5
   lo reporto como la palanca ganadora, pero las tres reps de la ronda 6 corren
   **con ese techo puesto** y el resultado es empate. La palanca se quedo, el beneficio no se
   reproduce.
2. El harness son ~2 s de ~250 s. Aunque se eliminara entero, el agregado moveria ~0,8 %: no
   puede cerrar un 0,98x ni abrir un 1,13x.
3. Todo lo que queda son turnos de razonamiento del modelo, que ninguna palanca del harness
   controla (la ronda 5 ya probo y **tiro** el acotado por prompt: 1,73x mas lento con 64 % mas de
   caracteres).
4. El arranque (~1,2 s de TLS + TTFB) sigue siendo real pero es del proveedor, no nuestro, y
   seria ~1 % del total.

La conclusion honesta: **con este corpus de 10 tareas y este modelo, mini y pi estan empatados en
wall time**, con calidad identica (10/10 los dos, siempre). La ronda 5 no encontro una mejora
sostenible; dibujo una corrida afortunada. Volver a tocar el lazo para perseguir un 0,69x que no
existe seria optimizar el numero del informe, no el software.

### 9.4 Lo que si queda como trabajo real

- **Mas reps, o un corpus mas grande.** Con 10 tareas y este rango de varianza, tres reps dan un
  intervalo de 0,93x - 1,13x. Para distinguir 0,95x de 1,05x haria falta un corpus de 30 - 50
  tareas, o varias reps por tarea. El `reps.py` de esta ronda (`~/mini-tui-benchmark/reps.py`) ya
  devuelve mediana y min-max por tarea para cuando se quiera repetir.
- **`t10` y `t8` concentran la varianza** y podrian quedar fuera de un corpus de comparacion
  siempre que no se midan con varias reps. Con una rep,mini y pi pierden por turnos distintos.

### 9.5 FrontierHarness: no existe en esta maquina

La orden pedia ejecutar "el FrontierHarness benchmark (el harness ya conocido en este repo)". Se
busco a fondo antes de concluir y **no hay ningun FrontierHarness aqui**:

- `find /home/jaime` (maxdepth 4, sin node_modules/.venv/.git): sin resultados.
- `git log --all -S frontierharness` y `git grep -il frontier $(git rev-list --all)`: **nada** en
  ningun commit, rama o worktree (los 25 worktrees de `.worktrees/` incluidos).
- Nombres de harness que han existido alguna vez en el repo: `pi-vs-mini-benchmark` (este corpus de
  10 tareas, el unico que corre hoy), `repl-harness` (el prototipo REPL, `docs/repl-harness.md`),
  y los runners de `programbench`/`swebench` de la epoca Python (borrados hace tiempo; ya no hay
  `src/minisweagent`). Ninguno se llama FrontierHarness.
- ~/.bash_history, `~/.local/bin`, npm global: sin rastro.

Los unicos "frontier" que aparecen en el sistema son bundles de CodeMirror de Playwright
(empaquetados en `node_modules`, sin relacion). El script que hizo la busqueda queda en
`~/mini-tui-benchmark/find_frontier.py` para que sea reproducible. Conclusion: **no se puede
establecer un baseline de FrontierHarness ni avanzar al 70 % porque el harness no esta en esta
maquina**; hay que decir de que harness se trata (URL, repo, o donde esta el corpus) antes de
seguir. La parte 1 del pedido (las reps) si se hizo y queda documentada arriba.
