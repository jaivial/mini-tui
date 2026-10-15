# UI generativa en el chat (protocolo `ui-component`)

El modelo puede "pintar" componentes nativos Svelte en el chat (estilo
open-generative-ui de CopilotKit, pero **sin React**: el renderizador es Svelte
con un set cerrado de plantillas validadas — nada de `eval` ni HTML crudo).

## Cómo emite un componente el agente

Dentro de su respuesta (texto final o texto que un tool deja en el hilo), un
bloque cercado:

~~~
```ui-component
{"template": "chart", "props": {"kind": "bar", "title": "Ventas", "labels": ["Ene","Feb","Mar"], "values": [12, 18, 9]}}
```
~~~

El server (`src/web/uiComponents.ts`) extrae el bloque del texto del assistant
durante el ingest y lo convierte en un evento de transcript de primera clase
(`{type: "ui-component", template, props}`) vía el feed WS/SSE existente. El
navegador lo renderiza con la plantilla Svelte correspondiente
(`web/src/lib/components/ui/`). Máximo 4 componentes por mensaje.

No hace falta ninguna tool nueva: la convención es el bloque cercado y funciona
desde cualquier runtime del bot que escriba texto en el hilo.

## Plantillas (set cerrado)

| template | props (validadas en `web/src/lib/ui/validate.ts`) |
| --- | --- |
| `card` | `title` (req), `body?`, `tone?: neutral\|info\|ok\|warn` |
| `list` | `items` (req; string o `{title, detail?}`, máx 50), `title?` |
| `table` | `columns` (req, máx 8), `rows` (req, máx 60×columns) |
| `chart` | `kind: bar\|line` (req), `labels` (req, máx 60), `values` (req, mismos que labels), `title?`, `unit?` |
| `form` | `fields` (req, máx 10: `{name, label, type: text\|number\|date\|select\|checkbox, required?, placeholder?, options?}`), `title?`, `submitLabel?` |
| `gallery` | `images` (req, máx 24; `/api/attachments/…` o `https?://` — nada más), `title?` |
| `progress` | `value` 0-100 (req), `label?`, `detail?` |

Reglas:

- Validación doble: el server valida la **forma** (JSON parseable, `template`
  conocido, `props` objeto) y el navegador valida los **props estrictamente**
  contra la whitelist de cada plantilla (tipos, cotas, claves desconocidas
  fuera). Un bloque roto o una plantilla desconocida degradan a un aviso
  discreto (`UiFallback`) — nunca a un error ni a HTML sin validar.
- Los `form` responden **en el chat**: al enviar, el componente publica un
  mensaje de usuario normal `[Título] campo: valor · …` por el mismo camino que
  la prompt bar.
- `gallery` reutiliza el lightbox de adjuntos para la vista a pantalla completa.

## Fallback

```ui-component
{"template": "calendar", "props": {}}
```
→ aviso "Componente no renderizado (calendar): plantilla no disponible".
JSON roto → "no se pudo leer el JSON del componente", con el detalle del parseo.
