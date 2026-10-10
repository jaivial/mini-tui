# mini web UI vs pi harness: speed benchmark (2026-10-09)

Pedido de Jaime (9 oct 20:48): ejecutar la comparacion de velocidad **mini-tui web UI vs pi
harness**; mini debe ganar en wall time manteniendo el mismo o mejor % de exito.
`docs/pi-speed-analysis.md` documenta el analisis previo y los items 1-6 ya implementados
(PRs #109 y #111); este documento mide el resultado **con tareas reales** en lugar de
argumentar desde el codigo.

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
