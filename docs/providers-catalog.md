# Catálogo de proveedores: límites, precios e índice de inteligencia

Investigación de los cinco proveedores conectados de verdad a mini-tui, para que el
router (qué modelo usar) y el usage-logging (cuánto cuesta) trabajen con datos reales
y no con suposiciones.

- **Fecha de consulta de todos los datos: 2026-10-15** (UTC). Los precios de estos
  proveedores cambian con frecuencia; si algo parece desfasado, la fecha manda.
- **Máquina:** servidor sin GPU. Solo importa para Ollama (concurrencia y contexto,
  no coste por token).
- **Fichero machine-readable:** [`config/model-catalog.json`](../config/model-catalog.json),
  generado por [`scripts/gen_model_catalog.py`](../scripts/gen_model_catalog.py).
  Este documento explica los datos; el JSON es lo que consume el código.

## Reglas de este documento

1. Cada dato lleva su URL de origen y la fecha de consulta.
2. Lo que no aparece públicamente va escrito como **`desconocido`**, literal. No hay
   cifras plausibles inventadas: un precio inventado contamina el router y el gasto.
3. El índice de inteligencia usa **Artificial Analysis**, con la puntuación tal cual
   aparece en su página, más la URL y la fecha.

## Advertencia sobre el índice de inteligencia

Artificial Analysis recalcula su Intelligence Index entre versiones. Al consultar el
2026-10-15 la versión viva era **v4.3.2**, y en ella GLM-5.3 puntúa **45**, no 60.
Fuentes secundarias (blogs, Reddit, X) siguen citando **57** o **60** para GLM-5.3 y
Kimi K3: son puntuaciones de la v4.1 y de versiones anteriores. Aquí se usa **solo**
el valor leído de la página oficial en la fecha de consulta, con su variante de
razonamiento, porque la variante cambia la nota (Kimi K3: 44 en *max*, 30 en *low*).

---

## 1. Resumen

| Proveedor | Base URL | Prefijo | Tipo de facturación | Límite publicado |
|---|---|---|---|---|
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `opencode-go/` | Suscripción por cuota | 20 % del límite mensual cada 5 h, 50 % semanal, 100 % mensual, **por modelo** |
| MiniMax | `https://api.minimax.io/v1` | `minimax/` | Pay-as-you-go **o** M Plan | Ventanas de 5 h y semanales; rpm/tpm desconocidos |
| Z.AI | `https://api.z.ai/api/coding/paas/v4` | `zai/` | GLM Coding Plan (créditos) | Créditos por 5 h y por semana, por tier (Lite/Pro/Max) |
| Kimi for Coding | `https://api.kimi.com/coding/v1` | `kimi-coding/` | Membresía (cuota compartida) | Ventana rodante de 5 h; mensual de créditos. Requests/5 h: **desconocido** |
| Ollama | `http://127.0.0.1:11434/v1` | `ollama/` | Local, sin coste | `OLLAMA_NUM_PARALLEL=1` por defecto, contexto 4096 por defecto |

Ningún proveedor publica cifras de **RPM** o **TPM** en su documentación pública. En el
JSON esos campos valen `desconocido`. El único límite numérico duro y comparable entre
todos es el de **Z.AI** (créditos por 5 h y por semana).

---

## 2. OpenCode Go

Fuente: <https://opencode.ai/docs/go/> ·landing: <https://opencode.ai/go> · consulta 2026-10-15.

### Suscripción y límites

Dos planes: **Go $10/mes** y **Go Plus $40/mes**. El precio por token es idéntico en
ambos; lo que cambia es el límite mensual por modelo.

Los límites se definen **en dólares mensuales**, no en requests:

| Ventana | % del límite mensual |
|---|---|
| 5 horas | 20 % |
| Semanal | 50 % |
| Mensual | 100 % |

El límite mensual es **distinto por modelo** (de $15 a $80 en Go, de $60 a $240 en Go
Plus). Es el campo que realmente decide el fallback: un modelo con límite de $15 se
agota mucho antes que uno de $60 con el mismo precio por token.

Opción **Use balance** en la consola: al agotar la cuota, las peticiones pasan al saldo
pay-as-you-go en lugar de bloquearse. Si el router asume bloqueo, esa opción rompe la
suposición.

### Requisito de transporte (crítico para el router)

La API **exige el header `x-opencode-session`**, estable por conversación. Sin él la
respuesta es `400 MissingSessionID`. Además pide un `User-Agent` que identifique al
cliente en vez de un nombre genérico de SDK. La propia documentación marca a **Hermes**
como cliente validado, con el fix de cabecera en PR #101864, fusionado después de v0.21.0.

### Precios por modelo (USD por 1M tokens)

Precio de referencia publicado. `—` = el proveedor no publica ese componente.

| Modelo | Input | Output | Cache read | Cache write | Límite mensual Go | Límite mensual Go Plus |
|---|---|---|---|---|---|---|
| GLM-5.3-Flash | $0.15 | $0.50 | $0.03 | — | $60 | $180 |
| GLM-5.3 | $1.40 | $4.40 | $0.26 | — | $15 | $120 |
| GLM-5.2 | $1.40 | $4.40 | $0.26 | — | $60 | $180 |
| Kimi K3 | $3.00 | $15.00 | $0.30 | — | $15 | $60 |
| Kimi K2.7 Code | $0.95 | $4.00 | $0.19 | — | $60 | $180 |
| Kimi K2.6 | $0.95 | $4.00 | $0.16 | — | $60 | $240 |
| LongCat-2.0 | $0.30 | $1.20 | $0.006 | — | $60 | $240 |
| MiMo-V2.6-Flash | $0.14 | $0.28 | $0.0028 | — | $60 | $120 |
| MiMo-V2.6-Pro | $0.435 | $0.87 | $0.003625 | — | $15 | $60 |
| MiniMax M3 | $0.30 | $1.20 | $0.06 | — | $60 | $180 |
| MiniMax M2.7 | $0.30 | $1.20 | $0.06 | $0.375 | $60 | $240 |
| Muse Spark 1.3 Contributor | $0.10 | $0.20 | $0.002 | — | $60 | $120 |
| Qwen3.8 Max | $2.00 | $6.00 | $0.25 | $2.50 | $15 | $60 |
| Qwen3.8 Flash | $0.15 | $0.47 | $0.016 | $0.20 | $30 | $90 |
| Qwen3.7 Plus (≤ 256K) | $0.40 | $1.60 | $0.04 | $0.50 | $60 | $180 |
| Qwen3.7 Plus (> 256K) | $1.20 | $4.80 | $0.12 | $1.50 | $60 | $180 |
| DeepSeek V4.1 Flash (off-peak) | $0.15 | $0.60 | $0.003 | — | $80 | $160 |
| DeepSeek V4.1 Flash (peak) | $0.30 | $1.20 | $0.006 | — | $80 | $160 |
| DeepSeek V4 Pro (off-peak) | $0.66 | $1.98 | $0.022 | — | $15 | $60 |
| DeepSeek V4 Pro (peak) | $1.32 | $3.96 | $0.044 | — | $15 | $60 |
| Hy4 preview | $0.834 | $2.501 | $0.042 | — | $30 | $120 |
| Hy3 | $0.14 | $0.58 | $0.035 | — | $60 | $240 |
| Space Bunny | $0.15 | $0.60 | $0.03 | — | $30 | $120 |
| Grok 4.7 / 4.6 (≤ 200K) | $2.00 | $6.00 | $0.50 | — | $15 | $60 |
| Grok 4.7 / 4.6 (> 200K) | $4.00 | $12.00 | $1.00 | — | $15 | $60 |
| GPT 6 Luna (≤ 272K) | $0.10 | $0.50 | $0.01 | $0.125 | $15 | $60 |
| GPT 6 Luna (> 272K) | $0.20 | $0.75 | $0.02 | $0.25 | $15 | $60 |
| GPT 5.6 Luna (≤ 272K) | $0.20 | $1.20 | $0.02 | $0.25 | $15 | $60 |
| GPT 5.6 Luna (> 272K) | $0.40 | $1.80 | $0.04 | $0.50 | $15 | $60 |
| Claude Haiku 5.5 (≤ 100K) | $0.10 | $0.50 | $0.01 | $0.125 | $15 | $60 |
| Claude Haiku 5.5 (> 100K) | $0.50 | $2.50 | $0.05 | $0.625 | $15 | $60 |
| Gemini 4 Argon Contributor | $4.00 | $20.00 | $0.20 | — | $60 (2x, temporal) | $240 (2x, temporal) |
| LongCat 2.5 Preview Free | Gratis | Gratis | Gratis | — | Ilimitado (temporal) | Ilimitado (temporal) |
| Step 5 Preview Free | Gratis | Gratis | Gratis | — | Ilimitado (temporal) | Ilimitado (temporal) |
| Cat Jam Free | Gratis | Gratis | Gratis | — | Ilimitado (temporal) | Ilimitado (temporal) |

Peak de DeepSeek: 01:00-04:00 y 06:00-10:00 UTC, lunes a viernes; el resto es off-peak.

### IDs de modelo exactos y endpoint

El endpoint de modelos es `https://opencode.ai/inference/go/v1/models`. Hay **tres
familias de endpoint** y el router debe elegir según el modelo, no solo por precio:

| Familia | Endpoint |
|---|---|
| `chat` (OpenAI-compatible) | `https://opencode.ai/inference/go/openai/v1/chat/completions` |
| `messages` (Anthropic) | `https://opencode.ai/inference/go/anthropic/v1/messages` |
| `responses` (OpenAI Responses) | `https://opencode.ai/inference/go/openai/v1/responses` |
| `google` (Gemini) | `https://opencode.ai/inference/go/google/v1beta/models/<id>` |

En OpenCode el id se escribe `opencode-go/<model-id>`, por ejemplo
`opencode-go/kimi-k3`. Los 31 ids están en el JSON bajo `providers[].models[].apiModelId`.

### Requests estimados por ventana (Go)

El proveedor publica estimaciones de requests por 5 h, semana y mes, derivadas de un
patrón de uso típico (p. ej. Kimi K3: 1.050 input + 76.500 cached + 300 output tokens
por request). **El uso real varía**; sirve para ordenar modelos, no para lógica de
reintentos. Ejemplos (Go / Go Plus):

| Modelo | 5 h | Semana | Mes (Go) | Mes (Go Plus) |
|---|---|---|---|---|
| Kimi K3 | 110 | 250 | 490 | 1.960 |
| GLM-5.3 | 220 | 540 | 1.080 | 8.640 |
| Qwen3.8 Max | 160 | 400 | 810 | 3.240 |
| MiniMax M3 | 3.200 | 8.000 | 16.000 | 48.000 |
| GLM-5.3-Flash | 6.320 | 15.790 | 31.580 | 94.740 |
| Modelos *Free* | Ilimitado | Ilimitado | Ilimitado | Ilimitado |

---

## 3. MiniMax

Fuentes: <https://platform.minimax.io/docs/guides/pricing-paygo> ·
<https://platform.minimax.io/docs/m-plan/intro> ·
<https://platform.minimax.io/docs/m-plan/faq> ·
<https://platform.minimax.io/docs/m-plan/monthly-offer> ·
<https://www.minimax.io/m-plan> · consulta 2026-10-15.

### Dos modos de facturación sobre la misma base URL

- **Pay-as-you-go**: descuenta del saldo de la cuenta, clave API estándar.
- **M Plan**: suscripción con cuota, clave *Subscription Key*.

**Las dos claves no son intercambiables.** Si el router cree que está en M Plan pero
envía una API Key estándar, el saldo de la cuenta se carga igual: es exactamente el
error que MiniMax documenta en su FAQ.

### Pay-as-you-go (USD por 1M tokens)

| Modelo | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| MiniMax-M3 (≤ 512K input) | $0.30 | $1.20 | $0.06 | — |
| MiniMax-M3 (> 512K input) | $0.60 | $2.40 | $0.12 | — |
| MiniMax-M2.7 | $0.30 | $1.20 | $0.06 | $0.375 |
| MiniMax-M2.7-highspeed | $0.60 | $2.40 | $0.06 | $0.375 |
| MiniMax-M2.5 *(legacy)* | $0.30 | $1.20 | $0.03 | $0.375 |
| MiniMax-M2.5-highspeed *(legacy)* | $0.60 | $2.40 | $0.03 | $0.375 |
| MiniMax-M2.1 *(legacy)* | $0.30 | $1.20 | $0.03 | $0.375 |
| MiniMax-M2 *(legacy)* | $0.30 | $1.20 | $0.03 | $0.375 |

**Priority tier**: `service_tier: priority` cuesta **1.5×** la tarifa estándar.
MiniMax-M3 en priority: $0.45 / $1.80 (≤ 512K) y $0.90 / $3.60 (> 512K).

`MiniMax-M3.1-Flash-Preview` **no tiene precio pay-as-you-go publicado**: solo está
disponible dentro de M Plan / MiniMax Code. En el JSON sus precios son `desconocido`.

### M Plan (suscripción)

| Tier | Mensual | Anual | Uso relativo |
|---|---|---|---|
| Go | $22 | $220 | 1× (base) |
| Explore | $55 | $550 | 3× |
| Build | $132 | $1.320 | 7.5× |

El anual son 10 meses pagados (2 gratis). Hubo un 50 % el primer mes con facturación
mensual hasta el 14 de octubre de 2026.

**Límites**: ventanas de **5 horas** y **semanal** para texto, imagen, audio y otros
modelos no-video; el **video solo tiene ventana semanal**. Ninguna cuota se acumula ni
arrastra al siguiente ciclo. La cuota se consume en función del modelo, la longitud de
contexto, la complejidad de la tarea y la profundidad de razonamiento.

**RPM/TPM: `desconocido`.** MiniMax dice que las peticiones se pueden limitar al
excederse, con recuperación en ~1 minuto, y que los límites pueden endurecerse en horas
pico, pero no publica cifras.

**Credit packs**: 1.000 Credits = $1, equivalentes al precio pay-as-you-go, válidos un
año. Se consumen cuando se agota la cuota del plan, empezando por los que caducan antes.

Consulta de cuota: `mmx quota`, la página de uso de la consola, o
`GET https://www.minimax.io/v1/token_plan/remains` con el Bearer.

---

## 4. Z.AI (GLM Coding Plan)

Fuentes: <https://docs.z.ai/devpack/overview> · <https://docs.z.ai/devpack/usage-policy> ·
<https://docs.z.ai/devpack/quick-start> · <https://docs.z.ai/guides/overview/pricing> ·
<https://z.ai/subscribe> · consulta 2026-10-15.

Es el único de los cinco con límites **numéricos y públicos**.

### Planes y créditos

| Plan | Mensual | Anual (30 % off) | Créditos / 5 h | Créditos / semana | Uso vs Lite |
|---|---|---|---|---|---|
| Lite | $18 | $12.6/mes | 2.000 | 10.000 | 1× |
| Pro | $80 | $56/mes | 12.000 | 60.000 | 6× |
| Max | $168 | $117.6/mes | 28.000 | 140.000 | 14× |

Planes de equipo: **Standard Seat $88/asiento/mes** (66.000 créditos/semana) y
**Premium Seat $188/asiento/mes** (155.000 créditos/semana).

Los créditos de 5 h se refrescan de forma dinámica 5 horas después del consumo; los
semanales, cada 7 días.

### Cómo se gastan los créditos

```
créditos = (input × multIn + cachedInput × multCached + output × multOut) / 10.000
```

| Producto | Input | Cached input | Output |
|---|---|---|---|
| GLM-5.3 | 6.9 | 1.7 | 24 |
| GLM-5.3-Flash (incluye MCP de visión) | 2.3 | 0.56 | 8 |
| MCP Web Search / Web Reader / Zread | — | — | 1.2 |

**Off-peak se cobra al 50 %** del ritmo estándar. Peak: lunes a viernes, 14:00-18:00
Singapore Time (UTC+8).

Tokens estimados por semana (rango = off-peak…peak, según cache hit rate):

| Cache hit | Modelo | Lite | Pro | Max |
|---|---|---|---|---|
| 95 % | GLM-5.3 | 48–97 M | 290–580 M | 676–1.352 M |
| 95 % | GLM-5.3-Flash | 146–292 M | 877–1.755 M | 2.047–4.095 M |
| 98 % | GLM-5.3 | 52–104 M | 313–627 M | 731–1.463 M |

### Modelos y enrutado

Todos los planes sirven **GLM-5.3** y **GLM-5.3-Flash**. Las peticiones a otros ids se
**redirigen automáticamente**:

| Id solicitado | Se enruta a |
|---|---|
| `glm-5.2`, `glm-5.1` | `glm-5.3` |
| `glm-4.7` | `glm-5.3-flash` |

Esto importa para el router: pedir `zai/glm-5.2` no da un modelo distinto, da GLM-5.3
facturado con los multiplicadores de GLM-5.3. El JSON lo marca con `routedToModelId`.

Endpoints: OpenAI Chat Completions `https://api.z.ai/api/coding/paas/v4` (el que usa
mini-tui), Anthropic `https://api.z.ai/api/anthropic`, OpenAI Responses
`https://api.z.ai/api/v1`.

### Precios pay-as-you-go (referencia, distinto del plan)

Del endpoint `api.z.ai/api/paas/v4`, USD por 1M tokens — útil para costear la salida del
plan o una llamada suelta:

| Modelo | Input | Cached input | Output |
|---|---|---|---|
| GLM-5.3-Flash | $0.15 | $0.03 | $0.50 |
| GLM-5.3-FlashX | $0.37 | $0.075 | $1.25 |
| GLM-5.3 | $1.40 | $0.26 | $4.40 |
| GLM-5.2 | $1.40 | $0.26 | $4.40 |
| GLM-5.1 | $1.40 | $0.26 | $4.40 |
| GLM-5 | $1.00 | $0.20 | $3.20 |
| GLM-4.7 | $0.60 | $0.11 | $2.20 |

### Restricciones que afectan al router

- El plan está **limitado a herramientas oficialmente soportadas** (20+); usarlo en una
  no soportada puede reducir los beneficios.
- No se permite compartir cuenta ni acceso multiusuario.
- Los límites de concurrencia **existen pero no se publican como número**: la guía dice
  "Lite para un proyecto, Pro para 1-2, Max para 2 o más", con aumento dinámico en
  off-peak. En el JSON: `desconocido` como cifra, con el consejo como texto.
- Z.AI usa el **código de error propietario 1113** para saldo insuficiente (mencionado en
  el FAQ de `z.ai/subscribe`). El router debe tratarlo como no reintentable.

---

## 5. Kimi for Coding

Fuentes: <https://www.kimi.com/code/docs/en/> ·
<https://www.kimi.com/code/docs/en/kimi-code/membership.html> ·
<https://www.kimi.com/code/docs/en/kimi-code/error-reference.html> ·
<https://www.kimi.ai/help/membership/membership-pricing> · consulta 2026-10-15.

### El detalle que rompe el routing

**La API cruda exige el prefijo del proveedor en el id**: `kimi-coding/k3`, no `k3`. Sin
el prefijo el servidor responde con un error de modelo inexistente. Es el mismo
mecanismo de prefijo que usa el resto de proveedores de mini-tui, pero aquí el mensaje de
error no lo aclara.

### Modelos y tiers que los desbloquean

| Model ID | Qué es | Plan internacional mínimo | Precio por token |
|---|---|---|---|
| `k3` | Kimi K3, contexto hasta 1M | Plus | No publicado para este endpoint |
| `k3-256k` | K3 limitado a 256K | Plus | No publicado para este endpoint |
| `kimi-for-coding` | K2.8 Preview | Plus | No publicado para este endpoint |
| `kimi-for-coding-highspeed` | K2.7 Code HighSpeed | Pro | No publicado para este endpoint |

`k3` con contexto 1M consume **~2× la cuota** que `k3-256k`. Dentro de 256K dan el
mismo resultado. Para el router: `k3-256k` es la opción de menor coste para el grueso
del trabajo, y `k3` solo cuando el contexto largo aporta de verdad.

El `User-Agent` debe conservar la identidad real del cliente; suplantarlo es una
violación que puede suspender los beneficios de la membresía.

### Membresía (precios, no límites)

Planes internacionales (USD):

| Plan | Mensual | Anual | Equivalente mensual anual |
|---|---|---|---|
| Plus | $19 | $180 | $15 |
| Pro | $39 | $372 | $31 |
| Max | $99 | $948 | $79 |
| Ultra | $199 | $1.908 | $159 |

Planes China (CNY): Go ¥49 (sin Kimi Code), Plus ¥99, Pro ¥199, Max ¥699.

Los planes nuevos **Plus en adelante** tienen ventana rodante de 5 h y **sin** ventana
semanal. Los legacy (Andante/Moderato/Allegretto/Alegro) conservan ambas.

### Límites: lo que se sabe y lo que no

| Límite | Valor |
|---|---|
| Requests por 5 h | **desconocido** |
| Requests por semana | **desconocido** (solo legacy) |
| Requests por mes | **desconocido** |
| Requests concurrentes | **desconocido** (existe el error 403 que lo dispara) |
| RPM / TPM | **desconocido** |
| Cuota mensual de créditos | compartida con el resto de la membresía, sin rollover |

Kimi publica **la forma del límite pero no su magnitud**. Todos los dispositivos y API
Keys comparten la misma cuota. Este es el punto flojo del catálogo: el router puede
detectar el agotamiento por el 403, pero no puede predecirlo.

**Extra Usage**: opcional, se activa en ajustes y solo se consume cuando la cuota de
suscripción está agotada. Mínimo ¥25 por recarga, hasta 10 recargas y ¥3.000 por día,
saldo máximo ¥10.000. Se factura cerca del precio de la API de la Kimi Open Platform
—como referencia, K3 está a $3.00 in / $0.30 cache / $15.00 out por 1M en
`api.moonshot.ai`, que es **un producto distinto** de `api.kimi.com/coding/v1`. El JSON
lo guarda en `openPlatformReferencePrice` con una nota que impide confundirlo.

---

## 6. Ollama (local)

Fuentes: <https://docs.ollama.com/faq> · <https://docs.ollama.com/api> · consulta 2026-10-15.

### Precio

**$0.00 por token.** La inferencia es local. No hay precio que registrar: el
usage-logging debe marcar estas llamadas como coste cero, no como coste desconocido.

### Lo que limita de verdad (sin GPU)

En esta máquina lo relevante no es el precio sino la capacidad:

| Parámetro | Valor por defecto | Fuente |
|---|---|---|
| `OLLAMA_NUM_PARALLEL` | **1** request en paralelo por modelo | docs.ollama.com/faq |
| `OLLAMA_MAX_LOADED_MODELS` | 3 × GPUs, o **3** en CPU | docs.ollama.com/faq |
| `OLLAMA_CONTEXT_LENGTH` | **4096** tokens | docs.ollama.com/faq |

Los requests por encima del paralelismo se encolan en **FIFO**. La RAM necesaria escala
como `OLLAMA_NUM_PARALLEL × OLLAMA_CONTEXT_LENGTH`. Sin GPU, todo va por CPU.

### Estado observado en esta máquina (2026-10-15)

- Cliente `ollama` **0.20.7** instalado; el binario está en `/usr/local/bin/ollama`.
- **`ollama.service` instalado pero inactivo**: `/v1/models` no responde y
  `connection refused` en `127.0.0.1:11434`.
- Modelos descargados, leídos de `~/.ollama/models/manifests`: **`qwen2.5:0.5b`** y
  **`qwen2.5:1.5b`** (1.3 GB en total).

El catálogo local se ha obtenido del disco, no de una llamada en vivo, porque el
servidor no está arrancado. Hay que arrancar el servicio para verificarlo.

### Routing

`connection refused` contra Ollama **nunca debe bloquear una ruta**: es el fallback más
barato que existe. La regla está en el JSON como `connection-refused`.

---

## 7. Índice de inteligencia (Artificial Analysis v4.3.2)

Fuente: <https://artificialanalysis.ai/> · páginas por modelo bajo
`https://artificialanalysis.ai/models/<slug>` · consulta 2026-10-15.

Ojo: la columna **Variante** importa. El mismo modelo puntúa distinto según el nivel de
razonamiento, y las comparaciones cruzadas sin esa columna no son válidas.

| Modelo | Índice | Variante | URL |
|---|---|---|---|
| Gemini 4 Argon | **53** | high | [/models/gemini-4-argon](https://artificialanalysis.ai/models/gemini-4-argon) |
| Grok 4.7 | **46** | xhigh | [/models/grok-4-7](https://artificialanalysis.ai/models/grok-4-7) |
| MiMo-V2.6-Pro | **46** | — | [/models/mimo-v2-6-pro](https://artificialanalysis.ai/models/mimo-v2-6-pro) |
| GPT-6 Luna | **38** | max | [/models/gpt-6-luna](https://artificialanalysis.ai/models/gpt-6-luna) |
| Qwen3.8 Max (0902) | **45** | 0902 | [/models/qwen3-8-max](https://artificialanalysis.ai/models/qwen-3-8-max) |
| Claude Haiku 5.5 | **43** | max | [/models/claude-haiku-5-5](https://artificialanalysis.ai/models/claude-haiku-5-5) |
| Kimi K3 | **44** | max | [/models/kimi-k3](https://artificialanalysis.ai/models/kimi-k3) |
| Kimi K3 | **30** | low | [/models/kimi-k3-low](https://artificialanalysis.ai/models/kimi-k3-low) |
| GLM-5.3 | **45** | max | [/models/glm-5-3](https://artificialanalysis.ai/models/glm-5-3) |
| GLM-5.3 | **34** | low | [/models/glm-5-3-low](https://artificialanalysis.ai/models/glm-5-3-low) |
| GLM-5.3-Flash | **42** | — | [/models/glm-5-3-flash](https://artificialanalysis.ai/models/glm-5-3-flash) |
| GLM-5.2 | **34** | max (deprecado) | [/models/glm-5-2](https://artificialanalysis.ai/models/glm-5-2) |
| DeepSeek V4 Pro 0813 | **36** | max | [/models/deepseek-v4-pro](https://artificialanalysis.ai/models/deepseek-v4-pro) |
| DeepSeek V4.1 Flash | **39** | max | [/models/deepseek-v4-1-flash](https://artificialanalysis.ai/models/deepseek-v4-1-flash) |
| MiMo-V2.6-Flash | **38** | — | [/models/mimo-v2-6-flash](https://artificialanalysis.ai/models/mimo-v2-6-flash) |
| MiniMax M3 | **29** | — | [/models/minimax-m3](https://artificialanalysis.ai/models/minimax-m3) |
| MiniMax M2.7 | **23** | — (deprecado) | [/models/minimax-m2-7](https://artificialanalysis.ai/models/minimax-m2-7) |
| Kimi K2.7 Code | **26** | — | [/models/kimi-k2-7-code](https://artificialanalysis.ai/models/kimi-k2-7-code) |
| Qwen3.7 Plus | **25** | — | [/models/qwen3-7-plus](https://artificialanalysis.ai/models/qwen3-7-plus) |
| Hy3 | **25** | — | [/models/hy3](https://artificialanalysis.ai/models/hy3) |
| LongCat 2.0 | **19** | — | [/models/longcat-2-0](https://artificialanalysis.ai/models/longcat-2-0) |

Modelos **sin página pública** en Artificial Analysis el 2026-10-15 → `desconocido`
en el JSON, sin sustituir por la nota de un modelo vecino:

`Hy4 preview`, `Qwen3.8 Flash`, `Muse Spark 1.2 / 1.3 Contributor`, `Space Bunny`,
`MiniMax-M3.1-Flash-Preview`, `Kimi K2.6`, `DeepSeek V4 Pro` en su página no-reasoning,
`Kimi K2.8 Preview` (`kimi-for-coding`), `gpt-5.6-luna`, `ollama/qwen2.5:*`.

### Lectura para el router

Con precios tan comprimidos (de $0.14 a $4.00 por 1M input) y calidades en un rango estrecho
(19-46), el índice por sí solo no basta. Las dos palancas reales:

1. **Costo por tarea**, no por token. Artificial Analysis lo publica por modelo: GLM-5.3
   $2.01/tarea, Kimi K3 $2.00, MiMo-V2.6-Pro $0.13, MiniMax M3 $0.51. MiMo-V2.6-Pro
   puntúa 46 con 15× menos coste por tarea que GLM-5.3.
2. **Límite de cuota**, que no aparece en ninguna tabla de calidad. Un modelo con
   índice 45 y límite mensual de $15 (GLM-5.3 en Go) rinde menos que uno con 38 y
   límite de $80 (DeepSeek V4.1 Flash) para un agente que habla mucho.

---

## 8. Errores que deben disparar fallback

Tabla completa en `errorFallbackRules` del JSON. Resumen:

| Estado | Significado | ¿Reintentar? | Proveedores |
|---|---|---|---|
| 401 | Key inválida/revocada, **o el plan no da acceso** a ese modelo/contexto | **No** | kimi-coding |
| 400 | Formato inválido; en opencode-go, falta `x-opencode-session` | **No** (arreglar y reenviar) | opencode-go, kimi-coding |
| 402 | No se pudo verificar la membresía | Backoff corto | kimi-coding |
| 403 | Cuota de 5 h / semanal / mensual agotada, o límite de concurrencia | **No** — fallback ya | kimi-coding, zai |
| 429 | Rate limit o motor sobrecargado | **Sí**, backoff exponencial | los cuatro remotos |
| 500 / 502 / 503 / 504 | Error interno o downstream caído | Sí, 2-3 intentos, luego fallback | kimi-coding |
| 404 | El id de modelo no existe en el plan | **No** — quitar del catálogo | kimi-coding |
| 1113 | Error propietario de Z.AI: saldo insuficiente | **No** | zai |
| 499 | El cliente canceló; no es error de servidor | No — ignorar en contabilidad | kimi-coding |
| connection refused | Ollama local apagado | No — **fallback inmediato** | ollama |

Las cuatro distinciones que más importan:

- **401 en kimi-coding no es solo autenticación.** También significa "tu plan no llega a
  `k3`" o "tu plan solo llega a 256K". Reintentar es inútil; hay que degradar el modelo.
- **403 no es transitorio.** A diferencia del 429, esperar no arregla una cuota
  agotada: hay que cambiar de proveedor.
- **1113 es el único código propietario** de los cinco. Viene de Z.AI y no aparece en
  ningún estándar; hay que mapearlo explícitamente.
- **Ollama apagado nunca bloquea.** Es la ruta de fallback más económica que tenemos.

---

## 9. Lo que queda como `desconocido`

Resumen honesto de los huecos, para que nadie los rellene con una suposición:

| Dato | Proveedores | Por qué |
|---|---|---|
| RPM y TPM | los cinco | Ninguno publica cifras en documentación pública |
| Requests por ventana | opencode-go, minimax, kimi-coding | Solo Z.AI publica límites numéricos (créditos) |
| Límite de concurrencia numérico | zai, kimi-coding | Z.AI lo describe por proyectos, no por número; Kimi tiene el error que lo dispara pero no el número |
| Precio por token del endpoint de codigo | kimi-coding | Se factura contra cuota; solo se publica "cerca del precio de la Open Platform" |
| Precio pay-as-you-go | minimax (`M3.1-Flash-Preview`) | Solo disponible dentro de M Plan |
| Índice de inteligencia | 10 modelos (listados en §7) | Sin página pública en Artificial Analysis |
| Modelos servidos por el plan | zai | Los ids antiguos se redirigen; el destino está documentado, el contenido del enrutado no |

**Dudas abiertas que conviene resolver con acceso autenticado** (no se han inventado
respuestas para ninguna):

1. ¿Qué **plan concreto** tiene activa cada conexión? De eso depende si el límite real
   es $15 o $240 en opencode-go, y 2.000 o 140.000 créditos en Z.AI. Solo la consola
   del proveedor lo dice.
2. ¿Está **activado "Use balance"** en la consola de OpenCode Go? Si lo está, una cuota
   agotada no bloquea: consume saldo. El fallback por 403 sería un bug.
3. Kimi no publica la magnitud de su ventana de 5 h. Con un plan Plus podría agotarse
   en una sesión larga de coding sin previo aviso; el único indicador es el 403.
4. El catálogo de Ollama se leyó del disco porque el servicio está inactivo. Con el
   servicio arrancado, `/v1/models` puede devolver más (o menos) de lo que hay en
   `manifests`.

## Cómo refrescar este catálogo

```bash
python3 scripts/gen_model_catalog.py
```

Las tablas viven en ese script como datos, no en el JSON a mano. Para refrescar:
actualizar la tabla, cambiar `CONSULTED_AT`, regenerar y volver a revisar las fechas.
Regla inviolable: si el dato no aparece en una fuente pública citable, se escribe
`desconocido`. Una cifra inventada aquí se convierte en una decisión de routing y en
un asiento de gasto equivocado.