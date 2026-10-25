# Reasoning effort por proveedor y modelo

Investigación contrastada con documentación oficial el **2026-10-25**. La tabla es la base de
`src/effort.ts`; la UI nunca inventa niveles para un modelo desconocido. **Auto** no envía ningún
parámetro y conserva el comportamiento del proveedor. Las preferencias se guardan por id completo
(`provider/model`) en `settings.json.modelEfforts`.

## Wire mapping

| API / proveedor | Control que se envía |
|---|---|
| OpenAI Chat Completions | `reasoning_effort: level` |
| OpenAI Responses | `reasoning: { effort: level }` |
| Claude Messages | `output_config: { effort: level }` |
| Claude vía cli-proxy (OpenAI-compatible) | `reasoning_effort`; el gateway lo traduce a `output_config.effort` |
| OpenRouter | `reasoning: { effort: level }`; Off usa `reasoning.enabled: false` |
| Ollama | `think: "low" | "medium" | "high"`; Off usa `think: false` |
| GLM / Kimi / DeepSeek / Xiaomi (según modelo) | `reasoning_effort` y/o `thinking.type` |

## Catálogo soportado

| Provider / familia | Niveles que ofrece mini | Default documentado | Restricciones |
|---|---|---|---|
| OpenAI GPT-6 Astra | Low, Medium, High, Extra high, Max | — | `none` devuelve HTTP 400; function calling requiere Responses |
| OpenAI GPT-5.6 (Luna/Terra) | Off, Low, Medium, High, Extra high, Max | Medium | Tabla del modelo Luna; sin Minimal |
| OpenAI GPT-5.5 | Off, Low, Medium, High, Extra high | Medium | Sin Minimal ni Max |
| OpenAI GPT-5.4 | Off, Low, Medium, High, Extra high | Off | Sin Minimal ni Max |
| OpenAI GPT-5.2 | Off, Low, Medium, High, Extra high | Off | Sin Minimal |
| OpenAI GPT-5.1 | Off, Low, Medium, High | Off | Sin Minimal, Extra high ni Max |
| OpenAI GPT-5 | Minimal, Low, Medium, High | — | Sin Off, Extra high ni Max |
| Otras GPT-5.x / o-series | Auto o subconjunto documentado | Depende del modelo | Familias no verificadas y GPT-4o-mini quedan en Auto |
| Claude Opus/Haiku 5.5 | Low, Medium, High, Extra high, Max | Medium | Adaptive thinking siempre activo; no se ofrece Off |
| Claude Sonnet 5.5 / Opus/Sonnet 5 | Low, Medium, High, Extra high, Max | High | `output_config.effort` |
| Claude Opus/Sonnet 4.6 | Low, Medium, High, Max | High | No se ofrece `xhigh` |
| Claude Opus 4.5 | Low, Medium, High | High | Puede combinarse con el legacy thinking budget |
| Claude 4.1 / Sonnet 4.5 / Haiku 4.5 | Auto | — | No se anuncia `output_config.effort` para estas filas |
| Z.AI / Zhipu / OpenCode GLM-5.3 (+ Flash) | Low, High, Max | Max | Thinking obligatorio; `disabled` no está soportado |
| GLM-5.2 | Off, Low, High, Max | Max | Off usa `thinking.type: disabled` |
| GLM-4.5–4.7 / 5 / 5.1 | Off, On | — | Switch de thinking, sin enum de profundidad documentado |
| Moonshot / Kimi Coding / OpenCode Kimi K3 | Low, High, Max | Max | Thinking y preserved thinking siempre activos |
| Kimi K2.7 Code | On | On | Thinking obligatorio |
| Kimi K2.6 | Off, On | — | Switch de thinking; no se inventa `reasoning_effort` |
| DeepSeek V4 / Chat / Flash | Off, Low, Medium, High | — | Thinking switch + `reasoning_effort` |
| DeepSeek Reasoner | On | On | Sin niveles documentados |
| OpenCode Grok 4.x | Low, Medium, High, Extra high | High | Responses; niveles documentados por xAI |
| OpenCode Claude (Messages) | Los de su familia Claude | Familia | `output_config.effort` en el endpoint Anthropic |
| OpenRouter | Los de la familia upstream detectada | Upstream | `reasoning.effort` unificado; ids desconocidos quedan en Auto |
| Groq Qwen 3.8 | Off, Low, Medium, High, Extra high | Extra high | `default` se representa como Auto |
| Groq GPT-OSS / Muse Spark | Low, Medium, High | Medium | No se ofrece Off a Muse Spark |
| Ollama GPT-OSS / Qwen3 / DeepSeek-R1 | Off, Low, Medium, High | Medium | `/api/show` es la autoridad para ids personalizados |
| Xiaomi MiMo | Off, On | — | Thinking switch; no hay enum portable verificado |
| MiniMax y modelos desconocidos | Auto | — | Sin enum de esfuerzo portable documentado |

Los ids de gateways (`cliproxy/`, `rosetta/`, `opencode-go/`) se clasifican por su familia upstream.
OpenRouter hereda los niveles de la familia upstream y su API unificada traduce el control; la UI
muestra esa advertencia. Para ids OpenRouter desconocidos y endpoints OpenAI-compatible genéricos
se conserva Auto.

## Fuentes oficiales

- OpenAI, [Reasoning models](https://platform.openai.com/docs/guides/reasoning): vocabulario
  `none/minimal/low/medium/high/xhigh/max`, `reasoning.effort` frente a `reasoning_effort`, y la
  restricción de `none` en GPT-6 Astra.
- Anthropic, [Effort](https://docs.anthropic.com/en/docs/build-with-claude/effort) y
  [Extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking):
  `output_config.effort`, niveles por familia y diferencias con `budget_tokens`.
- OpenRouter, [Controlling Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens):
  objeto unificado `reasoning`, `supported_efforts` y traducción a cada upstream.
- Ollama, [Thinking](https://docs.ollama.com/capabilities/thinking): booleanos y niveles definidos
  por el modelo; `thinking.values` de `/api/show`.
- Groq, [Reasoning](https://console.groq.com/docs/reasoning): niveles de Qwen 3.8, GPT-OSS y Muse.
- Z.AI, [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3),
  [GLM-5.3 Flash](https://docs.z.ai/guides/llm/glm-5.3-flash) y
  [GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2): `low/high/max` y thinking obligatorio en 5.3.
- Moonshot, [Chat Completion](https://platform.moonshot.ai/docs/api/chat): K3 y parámetros K2.x.
- DeepSeek, [Reasoning model](https://api-docs.deepseek.com/guides/reasoning_model): thinking y
  `reasoning_effort` en la petición Chat Completions.

## Persistencia y alcance

`PATCH /api/settings` valida cada nivel contra `effortCapability(model)`. Al crear un run,
`modelEnv()` serializa las preferencias concretas en `MINI_AGENT_MODEL_EFFORTS`; Rust aplica la
preferencia al construir cada modelo, incluidos los fallbacks, y `wire.rs` hace la traducción
específica de Responses. Auto nunca cruza al proceso. Los cambios afectan a runs nuevos; no se
presenta como si reconfiguraran retrospectivamente una petición HTTP ya en curso.
