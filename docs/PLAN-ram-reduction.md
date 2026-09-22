# Plan: bajar el uso de RAM por sesión (TUI + mini)

Estado: **fases 0–2 ejecutadas el 2026-09-22** (resultados en §7); fase 3 pendiente de decisión.
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
| B1 | `src/ui/App.tsx` (`MOUNTED_ITEMS`) | Bajar la ventana 120 → 80, o mejor: **presupuesto por filas en vez de por bloques** (se adapta al ancho del terminal) | −20 a −30 MB | 20 min (constante) / 1 h (presupuesto) | nulo (ya hay hint `g` para más historia) |
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
4. **Fase 3 — opcional/estructural** (según lo que midan las fases 1–2): B3, B4, A6, C2.

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

- **A2**: alguna ruta puede necesitar litellm implícitamente → detectar en Fase 0, mantener
  fallback `import` con mensaje de error accionable ("este modelo requiere litellm: pip install …").
- **B2**: los bloques colapsados pierden el resaltado → son de una línea (`1 tool call`); el
  resaltado vuelve al expandir. Aceptado explícitamente o ajustable con `settings`.
- **B3**: la API de scroll de opentui es limitada → prototipar detrás de un flag, medir, y caer
  a B1 (presupuesto por filas) si no compensa.
- **A4**: recortar extras podría romper consumidores que lean `raw_output` → el journal conserva
  los mensajes completos; recortar solo la copia en memoria.
