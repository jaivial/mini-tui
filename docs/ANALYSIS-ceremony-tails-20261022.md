# ANALYSIS-ceremony-tails-20261022 — dónde sigue costando la ruta orquestada tras los loops 1-8

> **Alcance**: profiling de solo lectura sobre trazas YA existentes en
> `~/.config/mini-tui/runs/` (corpus `benchmark/pi-vs-mini/parallel`), en dos cortes:
> (a) runs `20261021-205153` (directo) / `20261021-205748` (orquestado) del corpus pesado, y
> (b) los **64 runs post-#390** (sesiones `2026-10-21T19-29Z` en adelante, binario con los
> loops 4-8). **Ningún test, benchmark o arnés fue ejecutado** para este documento.
> `[MEDIDO]` = leído de trazas ya grabadas; `[HIPÓTESIS]` = impacto proyectado sin ejecutar nada.

## 0. Resumen

El estado de partida de este trabajo era main@7582052 (loops 1-3: una ola = un despertar, juez
saltado con verifier propio, lanzadera directa, corpus pesado). Entre el profiling y la
implementación, **main avanzó a los loops 4-8 (#390-#397)** — la misma campaña, otro agente —
y alcanzó: goal A a **1.11x sobre pi** (10/10) y goal B **S(8)=1.62-1.63** con partes de
1-3 minutos (`docs/ANALYSIS-delegation-nx-campaign-20261022.md`). Este documento re-mide los
cuatro cuellos de botella originales contra ese estado y deja constancia de cuáles siguen abiertos.

## 1. Los cuatro hallazgos medidos originalmente, re-medidos tras los loops 4-8

### 1.1 Doble confirmación del final en workers de ola — `[MEDIDO]` y **YA RESUELTO por #390**

`agent.rs:1233` solo aceptaba la primera respuesta sin tool call si había juez activo; los
workers de ola corren con `MINI_AGENT_GOAL_ORACLE=off` (diseño de #386) → siempre caían en el
`[FORMAT ERROR]` que obliga a regenerar la respuesta final entera.

| métrica (runs 205748, pre-#390) | valor |
|---|---|
| `[FORMAT ERROR]` en workers de ola | **15 en 12 workers** (padres: 0; brazo directo: 0) |
| tras el error: regeneración pura de la respuesta final | **12/15** — 1.321–7.201 chars repetidos |
| tras el error: verificación extra | 3/15 (`auth-log-analysis`) |
| cola de cierre (1ª respuesta final → exit) | 8,6–52,1 s, **media 23,0 s** |
| ahorro contrafactual de fin de ola | ph2 −16,2 s · ph4 −27,2 s · tp2 −48,9 s · tp4 −43,1 s |

`#390` (loop 4) lo resolvió exactamente por este lado: el juez apagado cierra ya en la primera
respuesta. **Confirmado en las trazas post-#390: 0 `[FORMAT ERROR]` en workers de 64 runs** —
la cola de confirmación desapareció. Sin cambio que aplicar; se documenta como validación.

### 1.2 `mini-tui` no resuelve en PATH de los padres — `[MEDIDO]` y **ABIERTO**

`subagents.rs` documenta la resolución como "MINI_TUI_BIN, luego la copia instalada, luego el
**bin/ del repo**", pero el código solo implementa los dos primeros pasos, y empuja a PATH la
ruta del **fichero** (que `command -v` no resuelve) en vez del directorio. En esta máquina no
hay copia instalada ni `MINI_TUI_BIN`.

| métrica (64 runs post-#390) | valor |
|---|---|
| comandos `mini-tui` con rc127 ("orden no encontrada") | **48** |
| turnos de padre con `mini-tui` fallido | **49** = **627,5 s de modelo** |
| turnos de padre con `mini-tui` OK | **4** de53 (el92% de los turnos con `mini-tui` fallan) |

El padre gasta giros enteros —o el intento completo de la tarjeta de sesión que su propio
system prompt le pide— en un comando que su propio hub promete y no entrega. `#396` mitigó un
síntoma (kanban search solo con tablero poblado) pero `tasks set` y el PATH siguen igual.

### 1.3 Los briefs del delegate duplican la especificación compartida — `[MEDIDO]` y **ABIERTO en corpus homogéneo**

| corrida (post-#390) | spec delegate | briefs | spec común repetida |
|---|---|---|---|
| ph4 `19-58-18` | **9.090 chars / 60,0 s de modelo** | 4 × ~2.210 | "six labeled lines", "ERROR percentage", "p50", "nearest-rank" en **4/4** briefs |
| big8 `21-45-54` | 12.308 chars / 102,3 s | 8 × 980–2.412 | partes heterogéneas: duplicación menor (0 párrafos comunes) |
| tp2 `20-06-37` | 1.480 chars / 7,6 s | 2 | spec de partes casi enteras |

`#390` recortó la prosa de coordinación (`task_message`) y los briefs bajaron de ~10,7 kB
(f4 medido el 21-10) a 1,5-5 kB en la mayoría, pero **en el corpus homogéneo la
especificación compartida se sigue pegando entera en cada brief**, y el giro de delegación
sigue siendo el más caro del padre (60-102 s de modelo en los waves de 4 y 8 partes). El
TASK.md ya viaja heredado en la conversación que cada worker recibe (medido: msg[1] del worker
contiene el TASK.md completo de 1.229 chars).

### 1.4 Handshake `surface:` fabricado en tareas non-code — `[MEDIDO]` y **ABIERTO**

`shared_context_note` se inyecta cuando el cwd tiene `.git` en ancestros (el workdir del
benchmark vive dentro del repo), y su bloque `handshake_block` exige "write these three lines …
Replace EVERY part with something real" **sin la exención non-code que mini.yaml ya tiene**
("Do not require code contracts, surface handshakes or builds for a non-code task").

| métrica | valor |
|---|---|
| respuestas finales de worker con `surface:` fabricado, runs 205748 | **9/12** |
| runs post-#390 con workers non-code fabricando `surface:` | **la mayoría** (p.ej. 4/4 en `19-58-18`, 4/4 en `20-07-41`, 7/7 en `22-15-29`) |
| fabricación típica | `surface: logs/miss.log:1 … -> parsed by /tmp/…` (scratch, no un consumidor) |

**[HIPÓTESIS]** alinear la exención en el bloque inyectado elimina esa fabrication y el
pensamiento dedicado a inventarla (medido en `miss`: bloque de razonamiento de 2.716 chars);
el coste funcional es cero para tareas que no entregan código (el informe ES el handoff).
Contraparte necesaria: sin líneas `surface:`, el chequeo `coverage` del `contract-check`
fallaría para cualquier cwd con `.git` — hoy solo se suprime el nag sin `.git`. Habrá que
extender la supresión a "sin contrato declarado" (contracts.md vacío), que es exactamente la
regla de mini.yaml ("only for INTEGRATION work with a contract actually declared").

## 2. Qué NO se tocó (y por qué)

- **Paralelismo de la ola**: sigue solapándose; el objetivo B ya mide S(8)=1.62 en main.
- **Hallazgo 1.1**: resuelto por #390; reimplementarlo duplicaría trabajo merged.
- **Harness puro, retries/`Retry-After`, `execute_batch`, `serialize`**: ya hechos en #109/#111.

## 3. Cambios propuestos sobre los hallazgos abiertos

| # | Cambio | Archivo(s) |
|---|---|---|
| 2 | Completar la resolución de `mini-tui`: fallback al bin/ del repo (`MINITUI_HOME` y relativo al ejecutable) y empujar el **directorio** a PATH | `agent-rs/src/subagents.rs` + espejo en `agent-rs/tests/context_store.rs` |
| 3 | Briefs de delegación = solo el delta de cada parte (el spec viaja heredado) | `agent/src/minisweagent/config/mini.yaml` |
| 4 | Exención non-code en el bloque `handshake` inyectado + supresión del nag `coverage` cuando no hay contrato declarado | `agent-rs/src/context_store.rs`, `agent-rs/src/subagents.rs` |

Verificación: **build** (systemd-run con límites) + **QA visual manual con cu**. Ninguna cifra
de tabla se promueve a "mejora conseguida" sin medición autorizada posterior.
