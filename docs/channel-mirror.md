# El espejo WhatsApp ↔ web (mirror)

La misma sesión visible en las dos superficies: lo que llega por WhatsApp
aparece en el transcript web de la sesión vinculada, y lo que se escribe en la
web sale por WhatsApp al hilo vinculado. Solo sesiones CON binding de
WhatsApp espejan; el resto queda normal.

## Dirección WhatsApp → web

El consumer (mini-channel-consumer) es quien decide si un mensaje aceptado
genera turno. Eso divide el espejo en dos caminos que nunca se solapan:

- **Mensajes CON turno** (DMs, menciones, grupos con policy `all`): el turno
  corre en la sesión (`runHeadless`), el journal/transcript se guarda en el
  `sessions.db` compartido y la web lo muestra por su propia sincronización.
  Estos NO se espejan en el mirror store: serían burbujas dobles.
- **Mensajes SIN turno** (grupos mencion-gateados, comandos de chat como
  `/newsession`): el consumer los registra en `channel_mirror` (mismo store
  `channels.sqlite`) con adjuntos best-effort (imagen/documento descargado al
  media store; audio solo metadatos). El servidor web sondea el store
  (`MINITUI_MIRROR_POLL_MS`, 1 s por defecto) y empuja eventos `channel` al
  transcript de las sesiones abiertas; el loader restaura los eventos al abrir
  una sesión y los re-adjunta tras cualquier rebuild (dedupe por `mirrorId`
  contra el transcript persistido).

## Dirección web → WhatsApp

`POST /api/sessions/:id/prompt` retransmite el prompt (y sus adjuntos:
imagen como imagen, resto como documento) a cada hilo con binding de la
sesión. Es fire-and-forget: nunca retrasa ni condiciona el turno del agente.

## Anti-bucles (lo importante)

El bucle temido es web → WhatsApp → eco del propio envío → turno del agente →
otro mensaje. Tres cierres independientes:

1. **Registro de envío propio**: cada id devuelto por un envío del relay se
   graba en `channel_own_sends` (`ChannelInbox.registerOwnSend`) ANTES de que
   el eco pueda llegar; el receiver lo rechaza en la frontera de accept
   (`isOwnSendId`), igual que un reply ledgerado del consumer.
2. **Guard del consumer**: un grupo `fromMe=true` cuyo id está probado en el
   historial saliente del hilo se acusa sin leerlo por ningún modelo (v4-H).
3. **Dropped en DMs**: fuera de grupos, `fromMe=true` ni siquiera se acepta.

El mirror, además, es solo DATO: un evento `channel` en la web jamás se
convierte en prompt ni genera turno, y los ecos descartados nunca llegan a
`channel_inbox`, así que no se re-espejan. El E2E de ping-pong (escribir en
web → llega al grupo sin turno del agente; escribir en el grupo mencion-gateado
→ aparece en la web sin turno) es la prueba de que los tres cierres aguantan.

## Indicador de origen

- Burbujas espejadas (eventos `channel`): icono + remitente + hora, burbuja
  con subrayado verde discreto.
- Mensajes de WhatsApp que SÍ generaron turno: llegan al transcript como el
  task event del turno, con su cabecera `[WhatsApp message received in bound
  thread …]` de siempre.
- Un prompt escrito en web y retransmitido se ve en el grupo como mensaje
  propio de la cuenta; en la web es el task event de siempre.

## Configuración (servidor web, mini-tui-web.service)

- `EVO_INBOX_DB` — el store compartido (mismo archivo que receiver/consumer).
- `EVO_API_URL` + `EVO_ACCOUNTS` (o `EVO_INSTANCE` + `EVO_INSTANCE_TOKEN`) —
  habilitan el relay saliente. Sin ellas el espejo es de solo lectura.
- `EVO_MEDIA_DIR` — de dónde se sirven los adjuntos espejados
  (`GET /api/channel-media/seq<seq>-<id>`; solo nombres del propio store).
- `MINITUI_MIRROR_POLL_MS` — sondeo del mirror (0 = desactivado).
