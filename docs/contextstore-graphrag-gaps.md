# ContextStore · GraphRAG · dedup — reconciliación y propuestas (2026-10-21)

Reconciliación por lectura sobre `agent/mc11-contextstore-20261021` (HEAD `7582052`), previa a
cualquier implementación. Sirve para distinguir lo que **ya existía**, lo que se **implementó en
este PR** y lo que queda como **propuesta** — sin afirmar cobertura que no se verificó.

## 1. Qué existía ya (verificado leyendo código, no de memoria)

| Área | Estado | Dónde |
|---|---|---|
| ContextStore 0.38.0 (`findings/contracts/decisions/surface.<repo>.md`) | Completo y conectado | `agent-rs/src/context_store.rs`; entrega en `subagents.rs` (spawn, handshake, contract-check, CLI `state/surface/contract-check`); `rlm.rs`; prompt en `mini.yaml`; `src/mini/sessionEnv.ts` |
| `surface` / `contract-check` | Completos (6 checks mecánicos) | `context_store.rs::surface()`, `::contract_check()`; defectos "pass over nothing" cerrados en 0.38.1/0.38.2 |
| GraphRAG (servicio de orquestación) | Completo, línea paralela a 0.38 | `scripts/orchestration_rag.py` (E5 qint8, floor .70, 6 chunks, dedup por fingerprint), `agent-rs/src/graph_retrieval.rs`, entrega en el launch de hijos (`subagents.rs`) |
| Dedup de chunks (RAG) | Hecha | fingerprint sha256 + `rag_hash` (revisiones) en `orchestration_rag.py` |
| Dedup del store (claves, paths, corpus, handshakes por nombre) | Hecha | `context_store.rs` |

## 2. Huecos reales encontrados

1. **Sin dedup entre las dos vías de entrega**: `context_blocks` (store) y `rag_block` (grafo)
   se concatenaban en `full_task` sin comprobar solapes → el mismo hallazgo entraba dos veces.
2. **`docs/semantic-delegation.md` describía la v1 del servicio** (MiniLM/.28/4 fuentes) mientras
   el código corre v2 (E5/.70/6 chunks) — dos docs del mismo sistema se contradecían.
3. **`docs/orchestration-plan.md` decía "Fase 2 sigue pendiente"** siendo hecha en 0.33.0 (y
   Fase 3 en 0.34.0, 4 en 0.36.0, 5 en 0.35.0, 6 en 0.38.0).
4. **Los dos interruptores no estaban documentados**: `MINI_AGENT_CONTEXT=0` apaga solo el store;
   el RAG depende de su propia URL.

## 3. Implementado en este PR (gaps acotados)

- **Dedup cruzado store↔grafo en el launch** (`agent-rs/src/graph_retrieval.rs`,
  `subagents.rs`): la retriever recibe lo que el hijo ya va a recibir y descarta los hits cuyo
  `text` (normalizado, ≥48 chars) ya aparece ahí; auditoría `dedup_skipped` / `hits_delivered` en
  el evento `graph_retrieval`; si todos los hits eran duplicados no se emite bloque
  `<graph-context>` vacío. **Solo cambia el caso en que había duplicado**: sin URL de servicio o
  sin solapes, el comportamiento es byte a byte el anterior.
- **Docs corregidos**: `docs/orchestration-plan.md` (estados de fase con su versión real),
  `docs/semantic-delegation.md` (v2 real + mención del dedup), `README.md` (dos vías de entrega
  y sus interruptores).

## 4. Propuesta documentada — NO implementado (gaps grandes)

Cada uno queda aquí con diseño y puerta de entrada; no se tocan por inercia.

### P1 — GC/consolidación de handshakes entre oleadas
*Situación*: los handshakes viven como `<child>.md` y nunca se prunan; `scoped_keys` crece con
cada oleada hasta el cap (`MINI_AGENT_CONTEXT_MAX`, 32k) donde `head_chars` recorta por silencio
y `notes_trimmed` avisa. Con oleadas largas el hijo puede quedarse sin los hallazgos recientes.
*Diseño*: consolidar `<child>.md` en `findings.md`/`contracts.md` al cerrar cada oleada (el
padre ya ejecuta contract-check en ese punto) y archivar lo consolidado; GC por antigüedad.
*Puerta*: medir primero (Fase 0 style) cuánto se recorta hoy en runs reales; sin esa cifra, no.

### P2 — Integración real store↔grafo (hoy no se hablan)
*Situación*: `grep MINI_AGENT_GRAPH_RAG_URL` solo aparece en `graph_retrieval.rs` y docs; el
store no ingiere nada del grafo ni el grafo lee `context/`. Hoy sólo se cruzan en el mensaje.
*Diseño* (dos variantes, elegir una): (a) indexar los documentos del store como chunks más en el
servicio RAG (scope por run, `rag_hash` ya soporta revisiones); (b) que `agent surface` consulte
también hits del grafo con la misma UI de `surface ls`.
*Puerta*: costo/beneficio con un run real comparado; y decidir `deploy/*.service` (ver P4).

### P3 — RAG solo en el launch, no en `agent send`
*Situación*: `graph_retrieval::context` se llama sólo en el launch central
(spawn/dispatch/plan/delegate/handoff). Un hijo reanudado con `send` no recibe evidencia nueva.
*Diseño*: llamar en el camino de `send` con el presupuesto restante, deduplicando contra los
mensajes ya en la conversación (el mismo mecanismo de este PR, contra el historial).
*Puerta*: decisión de producto — cada `send` costaría una llamada HTTP de 12s máximo; medir.

### P4 — `deploy/*.service` apuntan a otro checkout
*Situación*: `mini-tui-graph-rag.service` y `mini-tui-orchestration-graph.service` ejecutan
`/home/jaime/mini-tui-wa/scripts/*.py`, no este repo. En un entorno limpio no levantan nada.
*Por qué no se tocó*: cambiar la ruta afecta a los servicios que corren **ahora** en esta
máquina; hace falta que Jaime confirme cuál es el checkout activo (y si `mini-tui-wa` es
intencionado). **Requiere aprobación explícita.**

### P5 — Coste de contract-check (P2-D2/D3/D5 del plan pi)
*Situación*: `docs/OPTIMIZATION-PLAN-pi-20261021.md` sigue sin implementar P2-D2 (propiedad de
ficheros por tarjeta), P2-D3 (leer handshake/contract-check del almacén en vez de un turno
nuevo — el agrupado por wave de `subagents.rs` sólo cubre parte) y P2-D5 (oracle por ola).
*Puerta*: la regla de esta tarea prohíbe benchmarks; cualquier claim de velocidad necesita una
medición válida ya existente o autorizada por Jaime.

### P6 — Evidencia runtime de frescura
*Situación*: `docs/context-delivery-freshness.md` declara "Runtime evidence is pending; no tests
or benchmark changed". Cerrarlo exige ejecutar los e2e existentes, prohibidos por la regla
no-tests de esta tarea. **Queda pendiente para una tarea con tests autorizados.**

## 5. Fuera de alcance confirmado
- Nada de producción/despliegues/redes. Nada de `~/wt/loop1-3` ni del tmux de Jaime.
- Sin credenciales ni secretos en docs, código ni PR.
- Sin cerrar tarjetas: BIZ-67 pasa a *In Review*, el cierre es humano.
