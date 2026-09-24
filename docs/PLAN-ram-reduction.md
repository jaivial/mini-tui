# Plan: bajar el uso de RAM por sesión (TUI + mini)

Estado: **fases 0–3 ejecutadas** (resultados en §7–§9; 0.13.1 añade la ingestión TUI O(delta)).
Basado en medidas sobre sesiones reales y microbenchmarks reproducibles.

## 1. Punto de partida (medido)

| Componente | RSS actual | Composición |
| --- | --- | --- |
| TUI (`bun src/index.ts`) | 211–230 MB | base Bun + OpenTUI ≈ 150 MB + ventana de 120 bloques ≈ 60–80 MB |
| `mini` (python) | 226–235 MB | intérprete + CLI ≈ 35 MB + **litellm ≈ 198 MB al cargarse** + historial |
| `bash` de cada tool | ~1 MB (transitorio) | lo pesado lo retiene el comando hijo |
| **Total por sesión** | **~450 MB** | ~50 % TUI / ~50 % mini |

Microbenchmarks de importación (procesos frescos, `resource.ru_maxrss`):

| Import | RSS |
| --- | --- |
| `python3.10` pelado | 10 MB |
| `minisweagent` | 18 MB |
| `minisweagent.run.mini` (CLI completo) | 35 MB |
| `litellm` solo | **198 MB** |
| `openai` solo | 48 MB |

`-X importtime` sobre el CLI: 142 ms de arranque, de los cuales **63 ms es `prompt_toolkit`**
(vía `agents.utils.prompt_user`), que en modo `-y` (no interactivo) **no se usa nunca**.

## 2. Objetivo

- Sesión completa (TUI + mini) **< 300 MB** a corto plazo · **< 250 MB** con la fase estructural.
- `mini` **< 120 MB** · TUI **< 180 MB**.
- Memoria plana en runs de todo el día (TUI ya lo cumple; extender el techo a `mini`).
- Sin regresiones de UX salvo las marcadas explícitamente.

## 3. Palancas

### A · `mini` (el margen gordo: −120 a −160 MB)

| # | Dónde | Palanca | Ahorro estimado | Esfuerzo | Riesgo |
| --- | --- | --- | --- | --- | --- |
| A1 | — | **Medir primero**: `tracemalloc` por fase (imports vs historial) y confirmar qué ruta carga `litellm` en cada proveedor | gate de todo lo demás | 30–45 min | nulo |
| A2 | `agent/src/minisweagent/models/litellm_model.py`, `models/__init__.py` | **Import perezoso de `litellm`** (y de `openai`): solo se carga la pila del proveedor realmente elegido. Los proveedores directos (xiaomi, rosetta, deepseek, opencode_go, cliproxy) no deberían importar litellm | **−100 a −160 MB** | 1–2 h | medio (rutas litellm deben seguir funcionando → fallback con error claro) |
| A3 | `agent/src/minisweagent/run/mini.py` (`agents/utils/prompt_user`) | **Import perezoso de `prompt_toolkit`** solo en modo interactivo | −10 a −20 MB y −45 % de arranque | 15 min | nulo |
| A4 | `agent/src/minisweagent/agents/default.py` | **Recortar extras pesados** de cada mensaje (`extra.raw_output` duplica el output; respuestas crudas del API) una vez volcados al journal | −10 a −50 MB en runs grandes | 30–45 min | bajo (el journal conserva la copia completa) |
| A5 | `run/mini.py` | **GC**: `gc.freeze()` tras imports y `gc.collect()` por paso | −5 a −20 MB | 15 min | nulo |
| A6 | estructural | Cliente HTTP propio para los proveedores directos (sin litellm ni `openai`) o instalación slim con extras por proveedor | acerca `mini` a ~60–80 MB | medio día+ | medio (mantenimiento propio) |

### B · TUI (−40 a −130 MB)

| # | Dónde | Palanca | Ahorro estimado | Esfuerzo | Riesgo |
| --- | --- | --- | --- | --- | --- |
| B1 | `src/ui/App.tsx` (`mountedItemLimit`) | Presupuesto por filas/viewport en vez de 120 bloques fijos (24–120 items) | −20 a −30 MB | implementado en 0.13.0 | nulo (se conserva `g` para historia) |
| B2 | `src/ui/components/AssistantCard.tsx`, `StepCard.tsx` | **Markdown/`code` solo cuando aporta**: bloques colapsados y mensajes cortos en `<text>` plano; el renderable markdown + tree-sitter (coste fijo ~0.5 MB/bloque) solo al expandir o en pantalla | −30 a −80 MB | 2–3 h | medio (el look de los colapsados cambia; mantener la línea `1 tool call`) |
| B3 | `src/ui/App.tsx` + ScrollBox | **Virtualización real por viewport** (~20–30 bloques montados según posición de scroll) | −50 a −80 MB | medio día | medio (opentui no expone posición de scroll de forma cómoda; requiere heurística con `scrollBy`) |
| B4 | `src/ui/theme.ts` | Modo `low-memory` en `/settings`: desactiva resaltado tree-sitter (ni worker ni wasm) | −20 a −40 MB | 1–2 h | bajo |
| B5 | `bin/mini-tui` | Probar `bun --smol` / tuning de GC del runtime | 0 a −20 MB | 15 min | bajo (medir rendimiento) |

### C · Transversal

| # | Palanca | Por qué |
| --- | --- | --- |
| C1 | `MINITUI_PROFILE=1`: log de RSS/CPU por tick (como el harness de la 0.3.0) | validar cada palanca en sesiones reales, no solo en repro |
| C2 | Agente `mini` longevo entre turnos (un proceso por conversación, no por prompt) | amortiza intérprete + imports en sesiones multi-turno (−200 MB por turno extra) — estructural, solo si hace falta |

## 4. Fases

1. **Fase 0 — instrumentación** (30–45 min): A1 + C1 + microbench de B2 (bloque markdown vs texto).
   Gate: números por proveedor de quién carga litellm y cuánto cuesta cada tipo de bloque.
2. **Fase 1 — quick wins** (~1 h): A3, A5, B1. Medir antes/después con el workload estándar
   (400 pasos) y una sesión real.
3. **Fase 2 — los dos grandes** (3–4 h): A2 (imports perezosos por proveedor) y B2 (markdown
   selectivo). Validación: suite de agente (318 tests) + suite TUI (63 tests) + smoke de run real
   con cada proveedor configurado (xiaomi y litellm como mínimo).
4. **Fase 3 — estructural** (ejecutada en 0.13.0): A6, B3 y C2; el runner embebido y el
   presupuesto por viewport evitan la carga del CLI y recortan la ventana de montaje.

## 5. Criterios de aceptación

- Sesión completa (TUI + mini) **< 300 MB** medida con el workload estándar y con un run real de
  ≥ 1 h; objetivo estirado **< 250 MB**.
- `mini` sin `litellm` cargado cuando el proveedor es directo (verificado con RSS del proceso).
- Memoria plana en el tiempo (sin crecimiento sostenido durante el run).
- `bun test` (63) y `pytest` del agente (318 + los del journal) en verde; el único fallo conocido
  (`tests/run/test_local.py`, pre-existente del fork) sigue sin regresión.
- README y CHANGELOG actualizados con las mediciones nuevas.

## 7. Resultados (2026-09-22, fases 0–2 ejecutadas)

| Medida | Antes | Después |
| --- | --- | --- |
| Bloque de contenido (100 bloques, terminal 200 col) | 0.33 MB/bloque (`<markdown>`) | **0.09 MB** (`<text>`, 3.6×) |
| Import de `minisweagent.run.mini` | 35 MB | **20 MB** (−63 ms de arranque) |
| Carga estándar de 400 pasos (TUI) | 279 MB asentados (0.4.0) | **205 MB** (−26 %) |
| Carga de prosa plana de 400 pasos (TUI) | 549 MB (0.2.0, sin ventana) | **152 MB** (≈ base) |
| CPU carga estándar | 13,1 s | 12,7 s |
| Suites | — | agente **757 pass** / 36 skip · TUI **63 pass** |

Ajustes respecto al plan original, decididos con las medidas de la fase 0:

- **A2 no vale por sí solo**: los 6 proveedores heredan de `LitellmModel`, así que litellm
  (198 MB retenidos) se carga igualmente en cuanto hay query. El ahorro real es **A6** (fase 3).
- **B4 descartado**: el resaltado tree-sitter no cuesta RAM (0,32 MB sin él) — se conserva.
- **B1 innecesario por ahora**: con bloques de texto, 120 items cuestan ~18 MB; se mantiene la
  ventana de 120 por UX. Bajar a 80 sigue siendo el ajuste fácil si hace falta margen.

Sesión completa hoy: TUI 152–205 MB + mini ≈ 230 MB (de los cuales litellm ≈ 198) ≈
**380–435 MB** (antes ~450–465). El objetivo <300 MB requiere la fase 3.

## 8. Fase 3 (2026-09-22, 0.7.0)

Re-medición sobre 0.6.1 con sesiones reales (claude-opus-5-5 vía cliproxy):

| Medida | 0.6.1 | Palanca |
| --- | --- | --- |
| `mini` en un run real | 214 MB pico, 1ª respuesta a 5,2 s | **A6**: cliente directo para gateways |
| Import de `litellm` | 198 MB / 2,1 s | — |
| TUI viva, sesión de 817 msgs | 191 MB (pico 229) · 136 MB en `view` | historial crudo en memoria |
| Historial crudo retenido | 5,3 MB JSON, de los que 3 MB son `extra.response` / `raw_output` | D1 |
| Guardado cada 2 s | 6,4 MB de strings nuevos por guardado (17 ms) | D2 |
| CPU en reposo "working" | 4 % (el spinner re-renderiza todo el árbol 8×/s) | D3 |
| `bun --smol` | peor (157 vs 136 MB) | descartado |

- **A6 hecho**: `cliproxy/`, `rosetta/`, `xiaomi/` → `OpenaiCompatModel` (stdlib). Run real:
  **214 → 40 MB**, primera respuesta 2,3 s antes.
- **D1** — la TUI retiene solo lo que `--resume` necesita (sin `extra.response`/`raw_output`).
- **D2** — el transcript se guarda al terminar cada turno y cada 30 s, no cada 2 s.
- **D3** — el spinner es un componente aislado: su tick no re-renderiza la App.

- **A2**: alguna ruta puede necesitar litellm implícitamente → detectar en Fase 0, mantener
  fallback `import` con mensaje de error accionable ("este modelo requiere litellm: pip install …").
- **B2**: los bloques colapsados pierden el resaltado → son de una línea (`1 tool call`); el
  resaltado vuelve al expandir. Aceptado explícitamente o ajustable con `settings`.
- **B3**: la API de scroll de opentui es limitada → prototipar detrás de un flag, medir, y caer
  a B1 (presupuesto por filas) si no compensa.
- **A4**: recortar extras podría romper consumidores que lean `raw_output` → el journal conserva
  los mensajes completos; recortar solo la copia en memoria.

## 9. Integración estructural y TUI ligera (2026-09-23, 0.13.0)

La fase 3 se cerró con dos cambios que no alteran el protocolo de trayectoria:

- **Runner embebido**: `agent/src/minisweagent/run/tui.py` comparte `build_run_config()` con el
  CLI público, pero evita Typer, Rich, `prompt_toolkit` y el agente interactivo en yolo. La TUI
  usa el entry point `mini-swe-agent-tui` cuando existe y cae a `mini` para instalaciones antiguas
  o launchers personalizados. Cada run recibe un `MSWEA_CONTROL_FILE` nuevo, por lo que nunca se
  conecta al canal de una sesión anterior.
- **Presupuesto de montaje adaptativo**: la TUI monta aproximadamente dos viewports (mínimo 24,
  máximo 120 items) en vez de 120 items fijos. `g`/`G` conservan la paginación de historia.

Benchmark reproducible, siete procesos Python 3.10 frescos, modelo determinista y sin red
(`python3 scripts/benchmark-runtime.py --runs 7`):

| Camino | Mediana de arranque/run (rango de 7 muestras) | RSS pico |
| --- | ---: | ---: |
| `mini` público | ~205–212 ms | ~39 MiB |
| runner integrado | ~160–170 ms | ~34 MiB |

Resultado: aproximadamente **20 % menos tiempo** y **~5 MiB menos RSS** en el proceso del agente.
La cifra no incluye el proceso Bun/OpenTUI; separa el coste que puede atribuirse al boundary
Python. El transcript sigue siendo plano porque el presupuesto está acotado por viewport.

También se movieron `datasets` al extra `benchmarks` y se retiró el SDK `openai` de las
dependencias por defecto; los clientes HTTP directos no lo necesitan. `mini-swe-agent[full]`
conserva el conjunto completo.


### 0.13.1: TUI incremental ingestion

The second performance pass removed a hidden O(n) prefix scan from the live trajectory parser.
`messagesToEvents` now accepts a small retained `ParseState`; `App` passes it across append-only
journal snapshots and reuses its slim message array. The pure API keeps its old `startIndex`
behavior when no state is supplied. Reproduce with:

```bash
bun run benchmark:tui -- 5000
```

On the release machine this takes ~11–12 ms for 10,002 messages. This is a CPU/GC improvement for
long runs; it does not change journal bytes, rendered event shapes, or resume semantics.


### 0.13.2: incremental transcript item index

The renderer's tool-call/observation pairing index now has an explicit append-only cache. Live
journal updates extend it in O(delta); resume, `/new`, static scenes, and unusual out-of-order
arrivals use the original full rebuild. `tests/items.test.ts` fuzzes append/replacement sequences
against that full builder before the cache is trusted.
