# Plan de orquestación: DAG con scheduler dinámico + herencia de contexto

> Encargo de Jaime (audio WhatsApp, 6-oct-2026 22:53). Alcance: solo la vía Rust
> (`agent-rs` + orquestador Rust/TS de mini-tui); la vía Python está descatalogada y no se toca.
> Este documento es solo documentación: no cambia código de terminal ni se mergea sin revisión.
> Fuentes públicas consultadas sobre RLM al final del documento (verificadas, no asumidas).

Resumen ejecutivo: hoy mini-tui ya tiene subagentes reales con contexto propio, presupuestos y
notificaciones asíncronas, pero (1) la planificación es trabajo del modelo padre — que debe
recordar lanzar A2 cuando acabe A1 — y (2) cada subagente arranca en frío, sin nada de lo que el
padre ya descubrió. Proponemos: un planificador DAG ejecutado por el hub en Rust (el padre planifica
y revisa; el scheduler lanza en cuanto se desbloquean dependencias, maximizando paralelismo dentro
de los topes de memoria/coste), y herencia de contexto por capas: estado compartido en disco +
brief del padre (lo urgente y barato), resultados estructurados de hijos estilo RLM, fork de
contexto desde compactado para continuaciones, y un modo RLM completo como experimento separado.

---

## (a) Estado actual de la orquestación

### Cómo se crean los subagentes hoy

Cada ejecución de `mini-agent-rs` (salvo `MINI_AGENT_SUBAGENTS=0`) arranca un **hub**: un socket
Unix (`$MINI_AGENT_SOCKET`) más un thread monitor (`agent-rs/src/subagents.rs`, `subagents::start`).
El modelo dirige la orquestación con `mini-agent-rs agent …` desde su herramienta bash
(`spawn`, `send`, `model`, `resources`, `can-spawn`, `ls`, `status`, `wait`, `result`, `tail`,
`stop`, `ask` — ver `HELP` en `subagents.rs` y `skills/subagents/SKILL.md`).

`agent spawn <name> <task>` → `Hub::launch` → `Launcher::exec`:

1. **Valida y admite**: nombre válido; profundidad ≤ `MINI_AGENT_MAX_DEPTH` (2); vivos ≤
   `MINI_AGENT_MAX_SUBAGENTS` (100); **puerta OOM** con el mismo cálculo que `agent resources`
   (`agent-rs/src/resources.rs`: ~10 GiB de reserva de la máquina, coste medio por hijo medido
   como RSS de su grupo de procesos, `max_fanout`); presupuesto del hijo por defecto 200 pasos /
   $2 por turno, topado por lo que le queda a la sesión (el gasto de los hijos cuenta para el
   límite de coste del padre: `children_cost()` / `CHILD_COST`).
2. **Prepara el contexto del hijo** = literalmente el texto del `task` con los `$skills`
   referenciados inlaidos como bloques `<skill>` (`expand_skills`), nada más.
3. **Lanza un `mini-agent-rs` normal** en su propio grupo de procesos, con su `traj.json`/
   `traj.jsonl` y su **control file propio** abierto (`-y --exit-immediately -o … -c <configs del
   padre> -c agent.step_limit=… -l … -m <modelo> -t <task>`), y env
   `MSWEA_CONTROL_FILE`, `MSWEA_SILENT_STARTUP`, `MINI_AGENT_PARENT_SOCKET`, `MINI_AGENT_NAME`,
   `MINI_AGENT_DEPTH`.

El hijo trabaja hasta terminar su turno y **se queda "waiting" sosteniendo todo su contexto**:
`agent send` continúa con una línea `MESSAGE` (no re-lanza el proceso ni relee historia), y un
`send` en medio de un turno le llega antes de su siguiente llamada al modelo. Si el proceso
llega a morir, `--resume` lo relanza desde su conversación guardada (con `replaying` para no
re-notificar la historia antigua). Es decir: **la continuidad existe de hijo a hijo, no de padre a
hijo**.

El **monitor** del hub sigue el journal (`traj.jsonl`) de cada hijo y convierte sus eventos en
**notas** — mensajes de usuario que empiezan por `[subagent <name>]` — que el padre lee antes de
su siguiente paso, o que lo despiertan si ya había terminado su turno (`agent.rs`:
`add_subagent_notes`, `wait_for_followup`). Eventos notificados: fin de turno (con su resumen),
fallo (con la razón), stall (600 s sin escritura, `MINI_AGENT_STALL_S`) y `agent ask` del hijo.
El roster se publica en `<traj dir>/subagents/index.json` (nombre, estado, rutas, pid, memoria).

### Qué contexto recibe un subagente hoy

| Recibe | No recibe |
|---|---|
| El texto de su `task` (+ skills inlaidas) | El historial/conversación del padre |
| Los mismos config specs del padre (+ `MINI_AGENT_CHILD_CONFIG`) | Los hallazgos, búsquedas y lecturas que el padre ya hizo |
| El modelo del padre por defecto (`-m` para cambiarlo) | Resumen alguno del padre salvo lo que éste escriba a mano en el `task` |
| `cwd`, presupuesto propio, su control file | Contexto de otros hermanos |
| Estado propio entre turnos (`send`) | El contexto que tuvo antes de morir/re-lanzar salvo `--resume` de su propio traj |

**El arranque en frío es total**: cada hijo re-descubre archivos, re-hace búsquedas y re-lee código
que el padre (o un hermano) ya conoce. Ese es exactamente el obstáculo del eje 2 del encargo.

### Límites actuales

- Profundidad de anidación 2; ≤ 100 hijos vivos (y el gate de memoria corta antes).
- Presupuestos: 200 pasos / $2 por defecto por turno; coste total topado por el de la sesión.
- Stall a los 600 s; `agent wait` bloquea 20 s por defecto (el bash tool corta a 30).
- Un modelo call del padre por cada `spawn` (y por cada `wait`/`result` que consulte).

### Dónde está el código

| Pieza | Archivo |
|---|---|
| Hub, spawn/send/wait/monitor, `index.json` | `agent-rs/src/subagents.rs` |
| Notas → mensajes del padre, despertar al padre, coste compartido | `agent-rs/src/agent.rs` |
| Cálculo de fan-out (memoria, CPU, reserva) | `agent-rs/src/resources.rs` |
| Compactación de contexto (reutilizable para fork desde resumen) | `agent-rs/src/compaction.rs` |
| `index.json` → sesiones con `parent_id` para los UIs | `src/mini/subagents.ts` |
| Lanzamiento de runs (runners embedded/cli/rust) | `src/mini/spawn.ts` |
| Web: tira de subagentes bajo el padre, sesiones hijas, attach en vivo | `src/web/sessions.ts` |
| Web: socket de notas y task cards en vivo | `src/web/hub.ts` |
| Playbook de orquestación que sigue el modelo | `skills/subagents/SKILL.md` |
| Task cards (`mini-tui tasks set`) que los agentes rellenan | `src/cli/commands.ts` |
| E2E con modelos deterministas (sin red) | `agent-rs/tests/subagents.rs` |

La **versión web** no orquesta por sí: observa (tira de subagentes, sesiones con `parent_id`,
notas `[subagent …]` en vivo, task board) y puede enviar mensajes a los hijos (el mismo canal de
attach que el TUI). La planificación sigue siendo 100 % del modelo padre.

### Limitaciones concretas (los dos ejes del encargo)

1. **No hay DAG ni scheduler**: cuando A1 termina, *el padre* debe estar despierto, leer la nota y
   llamar a `spawn` para A2. Cada lanzamiento le cuesta un paso de modelo; la "planificación
   dinámica" es en realidad "recordatorio del padre", con latencia de un turno.
2. **No hay noción formal de paralelizable vs. dependiente**: está en prosa dentro de los textos
   de tarea; nada impide lanzar un sucesor antes de tiempo ni detecta ciclos.
3. **Arranque en frío**: sin herencia de contexto; el descubrimiento se paga N veces.

---

## (b) Propuesta: planificador DAG con scheduler dinámico

**Principio**: el padre deja de ser *lanzador* y pasa a ser *planificador + revisor*. El **hub en
Rust** (que ya es dueño de los hijos, de sus eventos y del cálculo de recursos) ejecuta el plan.

### Modelo de datos

Un plan, persistido en `<traj dir>/subagents/plan.json` (junto al `index.json`, versionado por el
traj, inspeccionable por los UIs):

```json
{
  "tasks": [
    { "id": "A1", "title": "localizar el código de spawn", "task": "…",
      "deps": [], "group": "repo-a", "priority": 1,
      "budget": {"steps": 60, "cost": 0.5},
      "artifacts": ["context/spawn-map.md"],
      "status": "running" }
  ]
}
```

- `deps`: ids de tareas que deben estar `done` antes de lanzar esta (**el DAG**).
- `group` (opcional): tareas que comparten ficheros se serializan entre sí aunque no haya
  dependencia (equivalente a los worktrees exclusivos que ya pide `$subagents`).
- `artifacts`: ficheros que la tarea se compromete a dejar escritos; el sucesor los recibe en su
  contexto automáticamente (engancha con el eje (c)).
- Estados: `pending → ready → running → review → done | failed | blocked`.
- **Validación al submit**: ids únicos, deps existentes, sin ciclos (DFS/toposort), plantillas
  sin referencias rotas.

### CLI (por el socket del hub, como `spawn`)

```
agent plan submit --file plan.json     # alta del DAG completo (validado)
agent plan add … / rm … / dep …        # re-planificación en caliente
agent plan show [--json]               # estados + cola ready
agent plan graph                       # aristas para el task board
```

### Scheduler dinámico (en el monitor del hub)

El monitor ya procesa eventos de los hijos cada tick; ahí se añade la máquina de estados del plan:

1. Un hijo pasa a `done` (evento de journal) → se marca su tarea `done` y se decrementan los
   contadores de dependencias de sus sucesores.
2. Toda tarea cuyo contador llega a 0 pasa a `ready`.
3. **Se lanza inmediatamente** toda tarea `ready` mientras quepan: `fanout_left() > 0` (memoria)
   y quede presupuesto (coste/pasos), por prioridad y orden topológico estable. Si no cabe,
   espera en cola y se reintenta en el siguiente evento/tick (la cola no es un fallo).
4. Handoff automático: la tarea del sucesor se materializa con el resumen/resultado del
   predecesor y sus `artifacts` (ver (c)).

Esto da exactamente el comportamiento pedido: **cuando A1 termina, A2 se lanza al instante aunque
el padre esté en otro turno o dormido; cuando Z1 termina, se lanza Z2, y cuando Z2 termina, Z3;
mientras tanto B, C, D siguen corriendo**, y el número de subagentes en paralelo se maximiza
sujeto solo a los topes reales de memoria/CPU/coste que `resources.rs` ya calcula.

### Papel del padre y de los UIs

- El padre recibe notas `[plan] A1 done → lanzando A2 (deps satisfechas)`, baratas, y solo
  interviene para **revisar resultados** (el criterio de `$subagents` se mantiene: un resumen es
  una afirmación, no prueba) y para **re-planear** (`agent plan add/dep/rm`).
- Web/TUI: reutilizar el **task board** existente para pintar el DAG (aristas desde `plan.json`,
  estados en vivo por el hub con un topic nuevo tipo `plan.watch`); la tira de subagentes no cambia.

### Alternativas descartadas

- *Que el padre encadene los spawns con notas* (hoy): coste O(tareas) de modelo, latencia de turno,
  y falla si el padre se distrae. Se mejora, no se sustituye de golpe: el plan puede empezar como
  sugerencia del padre y el scheduler adoptarlo.
- *Scheduler en el servidor web (TS)*: el TUI y el modo headless no lo tendrían; además los hijos,
  sus eventos y los topes viven en el hub Rust. El scheduler va donde está la información.
- *Daemon aparte*: más piezas móviles y despliegue; no hasta demostrar que el hub no basta.

---

## (c) Opciones de herencia de contexto (eje 2)

Problema: el hijo empieza sin nada de lo que el padre ya sabe (búsquedas de sitios, archivos
encontrados, decisiones tomadas). Opciones, de menor a mayor coste:

### 1. Brief del padre (resumen inyectado en el task)

El padre (o una plantilla `--brief` que lo obligue) escribe en el `task` un bloque estructurado:
objetivo del plan, rutas clave, convenciones, búsquedas ya hechas y su resultado, decisiones.
- **Coste**: infraestructura cero (solo plantilla y convención en `$subagents`); tokens O(brief)
  por hijo.
- **Beneficio**: elimina la mayor parte del re-descubrimiento; inmediato.
- **Riesgo**: pérdida u obsolescencia del resumen (mitigar: brief corto + `artifacts` para el
  detalle, ver opción 2).

### 2. Estado compartido en disco (hallazgos y artefactos)

`<run dir>/context/` (p. ej. `findings.md`, `search-cache.jsonl`, `artifacts/…`): convención
append-only de quién escribe qué (una tarea = un fichero de artefacto, tal como ya pide
`$subagents` con los REPORT.md), y el scheduler/padre pasa a cada hijo solo los fragmentos
relevantes (sus `deps` + su brief). Es la formalización de lo que hoy ya hace el filesystem
("los subagentes solo comparten el filesystem").
- **Coste**: casi cero; los hijos leen selectivamente.
- **Beneficio**: deduplica búsquedas entre hermanos; A2 hereda lo que A1 dejó escrito (pieza
  natural del handoff del DAG); persiste para el usuario.
- **Riesgo**: consistencia/staleness (mitigar: append-only, una tarea = un artefacto, marcar
  fecha/autor).

### 3. Fork de contexto (clonar parte del contexto del padre)

El hijo arranca con mensajes del padre: ya es posible escribiendo un traj sintético y relanzando
con `--resume` (soportado). Variantes:
- **Fork completo**: máxima fidelidad, pero N hijos × contexto del padre = carísimo y con
  *context rot* en cada hijo. Solo para tareas quirúrgicas muy concretas.
- **Fork desde compactado** (recomendada): reutilizar `compaction.rs` — el hijo arranca con el
  resumen del padre + últimos K mensajes. Coste acotado y predecible.
- **Fork entre hermanos**: A2 continúa desde el traj de A1 (fork de checkpoint), ideal para
  cadenas Z1→Z2→Z3 donde el contexto de trabajo es el mismo.

### 4. RLM (verificado en fuentes públicas)

**Qué es exactamente**: *Recursive Language Models* — paper **arXiv:2512.24601** (Alex L. Zhang,
Tim Kraska, Omar Khattab). Paradigma de inferencia que trata los prompts largos como parte del
**entorno externo**: el LLM los examina, descompone y **se llama a sí mismo recursivamente sobre
fragmentos** (sub-LLMs como llamadas a función; el contexto largo vive en variables de un
programa, no en la ventana). Resultados del paper: procesa entradas hasta **dos órdenes de
magnitud** por encima de la ventana de contexto; y aun en prompts cortos supera a compaction
(+26 % mediana), CodeAct con sub-calls (+130 %) y Claude Code (+13 %) en 4 tareas long-context
con GPT-5, a coste comparable. Entrenaron RLM-Qwen3-8B (+28,3 % sobre Qwen3-8B).

**Cómo lo usa Prime Intellect** (blog *Recursive Language Models: the paradigm of 2026*,
primeintellect.ai/blog/rlm, 1-ene-2026; código: `PrimeIntellect-ai/prime-agent` — *"A
Self-Improving RLM Harness"*, arXiv:2608.23552 — y `PrimeIntellect-ai/nano-rlm`):

- El modelo principal tiene **una sola herramienta: un REPL Python persistente** (IPython). El
  contexto largo (datos de entrada) vive en variables; solo se ve "imprimiéndolo", y la salida del
  REPL se capa (8192 chars/turno) **para forzar delegar** en vez de leerlo todo.
- **Sub-LLMs como funciones**: `rlm.agent.spawn(task=…)` / `llm_batch()` (batches paralelos). Las
  herramientas (bash, edición, web…) **solo las usan los sub-LLMs**, no el contexto principal:
  los tokens ruidosos nunca contaminan el hilo principal. La respuesta del sub-LLM es un **valor
  pequeño y estructurado** que el programa guarda en una variable; la respuesta final solo sale
  por `answer = {"content", "ready"}` (difusión sobre la propia cadena de razonamiento).
- Todo programático (archivo, shell, orquestación vía código), REPL en sandbox aislado, y el
  estado del REPL **sobrevive a las compactaciones** y a los reinicios.
- Prime Agent añade el **Continual Harness** (arXiv:2605.09998): memorias, prompts, skills y
  *specs de subagentes* como estado duradero que el propio agente refina (`/refine`, con
  snapshots/rollback), sesiones daemon, y comunicación directa agente-agente.

**Relación con nuestro problema**: el RLM ataca el arranque en frío desde el otro lado — no se
"hereda el contexto del padre", sino que el contexto vive **fuera** y se inyecta por programa solo
la parte necesaria; y los hijos devuelven **valores pequeños** que no inundan el contexto del
padre. Es perfectamente compatible con el DAG de (b): el DAG programa *cuándo*, el RLM gestiona
*qué contexto* viaja.

### Coste / beneficio

| Opción | Infra | Tokens por hijo | Fidelidad | Riesgo principal |
|---|---|---|---|---|
| 0. Hoy (solo task) | — | mínimos | nula | re-descubrimiento |
| 1. Brief del padre | nula | O(brief) | media (resumen) | pérdida/obsolescencia |
| 2. Estado compartido en disco | baja | selectivos | media-alta | consistencia |
| 3a. Fork completo | media (traj sintético + `--resume`) | O(contexto padre) | alta | coste ×N, context rot |
| 3b. Fork desde compactado | media (reusa `compaction.rs`) | O(resumen + K) | media-alta | resumen demasiado grueso |
| 4. RLM (variables + sub-LLMs + REPL) | alta (REPL, sandbox) | mínimos (valores estructurados) | alta (bajo demanda) | superficie de mantenimiento |

### Recomendación

Por capas, sin romper lo que funciona:

1. **Ya y barato**: (2) estado compartido + (1) brief estructurado automático. Resuelve el 80 %
   del arranque en frío y encaja con el handoff `artifacts` del DAG.
2. **RLM-lite** (préstamos concretos, sin REPL): resultados estructurados de los hijos
   (`agent result --json` + artefactos en disco) en vez de solo prosa; interpolación de variables
   al construir tareas (`{{artifacts.spawn_map}}`); `agent spawn --batch` análogo a `llm_batch`.
3. **Fork desde compactado** como opt-in para continuaciones (Z1→Z2→Z3, A2 tras A1).
4. **Modo RLM completo** como experimento separado (hay un prototipo sin commitear en el árbol:
   `agent-rs/src/rlm.rs` + `agent-rs/tests/rlm.rs`, un REPL con `let/set`, `def/call`, `ask`,
   `run`, `save/load`). No acoplarlo al orquestador hasta medir (ver Fase 0/6): RLM y DAG son
   ortogonales — el DAG es el *scheduler*, el RLM la *economía de contexto*.

No adoptar: fork completo por defecto (caro y con context rot), ni el REPL Python como herramienta
única del orquestador todavía (cambiaría toda la ergonomía del TUI/web de golpe).

---

## (d) Plan por fases (pequeñas), con riesgos y tests

**Fase 0 — Métricas del arranque en frío** (1–2 días)
Instrumentar cuántos pasos/tokens dedica un hijo al re-descubrimiento (comandos de lectura/busca
en el journal) y cuánto costaría un brief. Sin cambios de comportamiento.
*Riesgos*: ninguno. *Tests*: n/a (solo medición).

**Fase 1 — Brief + contexto compartido** (2–4 días)
`agent spawn --context-file F` / plantilla `--brief`; convención `<run dir>/context/`;
actualizar `skills/subagents/SKILL.md`.
*Riesgos*: tareas más grandes (medir en Fase 0); convención ignorada (hacerla explícita y
automática, no dependiente del buen hacer del modelo). *Tests*: e2e con modelos deterministas al
estilo `agent-rs/tests/subagents.rs` (sin red): el hijo recibe el contexto; `expand_skills` sigue
intacto; límites de tamaño del task.

**Fase 2 — plan.json + scheduler dinámico en el hub** (1–2 semanas)
`agent plan …`; máquina de estados en `Hub::monitor`; lanzamiento automático de sucesores;
handoff de `artifacts`; notas `[plan]`.
*Riesgos*: condiciones de carrera (el hub ya serializa con un mutex; procesar eventos por tick);
ciclos en el DAG (validar en submit); explosión de coste (tope por tarea + los topes globales
existentes); reproducibilidad (todo queda en `plan.json`/`index.json` junto al traj); un plan
"tonto" del modelo (revisión del padre sigue siendo obligatoria).
*Tests*: unitarios del scheduler (grafo → ready-queue, topes de fan-out/coste, fallo → `blocked`,
reintentos) con reloj/eventos simulados; e2e A1→A2 auto-lanzado mientras B corre; e2e Z1→Z2→Z3
encadenado; e2e de fallo con notificación al padre. Todos deterministas, sin modelo real ni red.

**Fase 3 — Visualización en web/TUI** (3–5 días)
DAG en el task board (aristas desde `plan.json`, topic `plan.watch` en `src/web/hub.ts`), notas
`[plan]` en el feed, atajos para revisar/adjuntar hijos.
*Riesgos*: churn de UI. *Tests*: tests del protocolo del hub (`tests/web-hub.test.ts`) con el
topic nuevo; snapshots de la tarjeta con estados del plan.

**Fase 4 — RLM-lite** (3–5 días)
`agent result --json`; interpolación `{{var}}` desde `plan.json`/`context/` al materializar
tareas; `agent spawn --batch` (análogo a `llm_batch`).
*Riesgos*: compatibilidad del formato de mensajes con los UIs (hoy `result` es prosa). *Tests*:
e2e de resultados estructurados y de batch con presupuestos compartidos.

**Fase 5 — Fork desde compactado** (opcional, 3–5 días)
Fork padre→hijo desde el resumen de `compaction.rs` + últimos K mensajes; fork hermano
(Z2 continúa el traj de Z1) vía `--resume` de traj sintético.
*Riesgos*: coste de tokens (presupuesto por fork), resumen demasiado grueso (K ajustable).
*Tests*: e2e de fork con verificación de presupuesto; el hijo "sabe" lo que el padre sabía.

**Fase 6 — Modo RLM completo** (opcional/experimental, guiada por datos)
Consolidar el prototipo `agent-rs/src/rlm.rs` (REPL con variables y sub-agentes como llamadas,
`save/load`) detrás de un flag; comparar con el orquestador actual en las métricas de Fase 0.
*Puerta de entrada*: solo si Fase 1–2 no alcanzan las métricas. *Riesgos*: dos orquestadores que
mantener, superficie nueva. *Tests*: los del prototipo (`agent-rs/tests/rlm.rs`) + paridad con
`agent` en presupuestos y notas.

**No hacer**: código Python; scheduler en el servidor web; dar el REPL como herramienta única al
orquestador sin medir; fork completo por defecto.

---

## Fuentes consultadas (RLM, verificadas 6-oct-2026)

- *Recursive Language Models*, Zhang, Kraska, Khattab — https://arxiv.org/abs/2512.24601
- *Prime Agent: A Self-Improving RLM Harness* — https://arxiv.org/abs/2608.23552 y
  https://github.com/PrimeIntellect-ai/prime-agent
- *Continual Harness: Online Adaptation for Self-Improving Foundation Agents* —
  https://arxiv.org/abs/2605.09998
- Blog de Prime Intellect, *Recursive Language Models: the paradigm of 2026* (1-ene-2026) —
  https://www.primeintellect.ai/blog/rlm
- Implementación mínima: https://github.com/PrimeIntellect-ai/nano-rlm
- Implementación original del paper: https://github.com/alexzhang13/rlm
