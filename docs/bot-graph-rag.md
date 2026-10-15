# Bot graph RAG compartido (`scripts/botgraph.py`) + visibilidad de kanban

Cada bot escribe y lee su **subgrafo namespaced** en el graph RAG de producción
(neo4j-rust, `bolt://127.0.0.1:7687`, systemd `neo4j-rust.service`), puede
**consultar el grafo general** (lo que otros bots guardaron + VillaCarmen) y
**ver el kanban/tarjetas de otros bots en read-only**.

## Instalación para un bot

`botgraph` necesita el driver python `neo4j`; si falta, se re-ejecuta solo con
`~/.venvs/neo4j-e2e/bin/python`. Launcher recomendado:

```sh
ln -sf ~/mini-tui/scripts/botgraph.py ~/.local/bin/botgraph
```

## Contrato de namespacing (no romper)

- Etiquetas reservadas del layer: **`Bot`** y **`BotFact`**. `botgraph` nunca
  escribe nada fuera de ellas; el grafo base (VillaCarmen, 8036 nodos) queda
  intacto.
- Estructura: `(:Bot {id})-[:OWNS]->(:BotFact {id: "<bot>/<key>", bot, key, text, kind, ts})`
  y `(:BotFact)-[:RELATED {kind}]->(:BotFact)` dentro del propio subgrafo.
- `bot id`: slug estable por bot/sesión (`wa2`, `ops-bot`, …). Las escrituras de
  un bot jamás tocan las de otro.

## Comandos

```sh
botgraph save   --bot wa2 --key pagos-v2 --kind decision --text "API de pagos migrada a v2"
botgraph find   --q "pagos"                    # busca en TODOS los subgrafos (grafo compartido)
botgraph find   --q "pagos" --bot wa2          # acotado a un subgrafo
botgraph get    --bot wa2                      # leer el propio subgrafo
botgraph link   --bot wa2 --from-key pagos-v2 --to-key contacto
botgraph bots                                  # qué bots tienen subgrafo
botgraph query  --cypher "MATCH (n:Endpoint) RETURN n.key LIMIT 10"
botgraph kanban                                # tarjetas de todos los bots + kanban hermes (read-only)
botgraph kanban --session <bot-id>             # la tarjeta de un bot concreto
botgraph forget --bot wa2 [--key k]            # borrar lo propio
botgraph e2e                                   # E2E cross-bot completo
```

- `query` es read-only por defecto (rechaza CREATE/MERGE/SET/DELETE salvo
  `--write`); úsalo para consultar el grafo general.
- `kanban` es SIEMPRE read-only: lee `mini-tui sessions` + `mini-tui tasks show`
  y `hermes kanban list`. Un bot gestiona su propio kanban con sus herramientas
  normales; aquí solo mira el de los demás.

## E2E cross-bot (criterio de aceptación)

`botgraph e2e` ejercita: bot A guarda → bot B encuentra (búsqueda general y
acotada), namespacing (B no ve datos de A en `get`), B ve la tarjeta kanban de
A, guard read-only de `query`, cleanup y grafo base intacto. Verificado contra
producción :7687 y contra un server de test en :17687.

## Notas del motor

- El subset Cypher de neo4j-rust no tiene `timestamp()`; el cliente pasa `ts`.
- Pre-fix 2026-10-15: una query que empezaba por whitespace se clasificaba como
  EXPLAIN y NO se ejecutaba (resultado vacío silencioso). Arreglado en
  neo4j-rust (`run_statement`); las strings multi-línea indentadas ya ejecutan.
