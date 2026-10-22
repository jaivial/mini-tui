# Terminal-Bench vía Harbor — benchmark alternativo de BIZ-59

Preparación ejecutable para correr **Terminal-Bench 2.0** (Apache-2.0, dataset y verificadores
públicos) contra **`mini-agent-rs`**, el núcleo de agentes de mini-tui. El análisis completo —
candidatos descartados con fuente, métricas y plan por fases con gates — está en
[`docs/benchmark-alternativo.md`](../../docs/benchmark-alternativo.md).

| Fichero | Qué hace |
| --- | --- |
| `setup.sh` | Instala Harbor en un venv, descarga los datasets (`terminal-bench@2.0`, `terminal-bench-sample@2.0`) y compila `mini-agent-rs` estático (musl). Todo bajo `$BENCH_ROOT` (**fuera** del repo: ~600 MB de tasks + venv + imágenes). |
| `mini_agent_rs.py` | Adaptador custom de Harbor (`-a mini_agent_rs:MiniAgentRs`): sube binario + YAML al contenedor, corre el agente y deja la trayectoria en el formato que Harbor convierte a ATIF. |
| `run_pilot.sh` | Piloto acotado F0: brazo `oracle` (sin modelo) y brazo `mini` sobre 2 tasks de `terminal-bench-sample@2.0`, `-n 1`, todo en `systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G`. |
| `record_receipt.py` | Convierte los `result.json` de un job de Harbor en una fila de `receipt/runs.csv`. Solo lee métricas medidas; no estima nada. |
| `receipt/runs.csv` | El receipt: una fila por job (score, rewards, wall del agente, wall del job, tokens, versión de harbor y commit del binario). |

## Arranque

```bash
bash benchmark/terminal-bench/setup.sh      # una vez
bash benchmark/terminal-bench/run_pilot.sh  # F0: oracle + mini + receipts
ARMS=mini bash benchmark/terminal-bench/run_pilot.sh   # repetir solo un brazo
```

## Credenciales

El brazo `mini` necesita `XIAOMI_API_KEY`. `run_pilot.sh` la lee de `~/.config/mini-tui-web.env`
y fija `XIAOMI_API_BASE=https://token-plan-sgp.xiaomimimo.com/anthropic/v1` (superficie Anthropic
con `cache_control` rodante). **La clave nunca se escribe en este repo, en el receipt ni en los
logs**: el adaptador la reenvía solo como variable de entorno del `exec` del contenedor.
