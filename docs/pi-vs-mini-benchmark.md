# mini web UI vs pi harness: speed benchmark (2026-10-09)

Pedido de Jaime (9 oct 20:48): ejecutar la comparacion de velocidad **mini-tui web UI vs pi
harness**; mini debe ganar en wall time manteniendo el mismo o mejor % de exito.
`docs/pi-speed-analysis.md` documenta el analisis previo y los items 1-6 ya implementados
(PRs #109 y #111); este documento mide el resultado **con tareas reales** en lugar de
argumentar desde el codigo.

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
