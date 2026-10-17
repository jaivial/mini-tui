/**
 * E24. Un remitente de WhatsApp se mostraba (y se leia en voz alta) como un
 * numero de 15 digitos, porque el nombre que el proveedor envia se descartaba.
 *
 * El item que E19 dejo anotado sin atacar ("el `senderName` quita el dominio y
 * deja el numero"). MEDIDO contra el receptor DESPLEGADO (4318) y el build
 * DESPLEGADO (Chrome 145, `index-w5aSVxsg.js`):
 *
 * (1) **EL PRODUCTOR YA LO ENVIA.** El fork (`evo-weai`, `crates/wa-client/
 *     src/recv.rs:309`) lee el atributo `notify` de la stanza — el nombre que el
 *     remitente eligio para si — y `weai-events/src/map.rs:180` lo publica como
 *     `pushName` en el `MESSAGES_UPSERT`. Medido con un POST real al receptor:
 *     HTTP 200, `accepted: 1`, y el `pushName: "Jaime Villanueva"` **no aparece
 *     en la fila guardada**. `normalizeEvo` (src/channels/evo.ts) leia `key.participant`
 *     y tiraba el resto: se quedaba la mitadstable de la identidad y se
 *     descartaba la que se lee.
 * (2) **LO VEIA TODO EL MUNDO.** Medido en vivo con CDP contra el transcript:
 *     los nombres accesibles de las filas del espejo eran `242554100576489`,
 *     `346000111111`, `346000222222` — los tres primeros发言 de una conversacion
 *     de grupo, indistinguibles. Y el AGENTE recibia lo mismo: el prompt llevaba
 *     `sender 242554100576489@lid`, un numero, sin quien lo habia escrito.
 *
 * El arreglo es una sola regla en un solo sitio (`src/channels/senderName.ts`)
 * para que la web, el inbox y el prompt del agente no puedan divergir. Y una
 * regla de seguridad que va con ella: **el nombre es etiqueta, nunca
 * identidad**. El jid sigue siendo lo que compara `allowedSenders`, asi que un
 * nombre auto-declarado no puede autorizar un turno ni aparecer en uno.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelInbox } from "../src/channels/inbox";
import { MirrorStore, mirrorEvent } from "../src/channels/mirror";
import { normalizeEvo } from "../src/channels/evo";
import { turnPrompt } from "../src/channels/consumer";

const GROUP = "120363432356582563@g.us";
const JID = "242554100576489@lid";

function delivery(extra: Record<string, unknown> = {}, key: Record<string, unknown> = {}) {
  return {
    event: "messages.upsert",
    instance: "x",
    date_time: "2026-10-17T10:00:00.000Z",
    data: [
      {
        key: { id: "E24-1", remoteJid: GROUP, fromMe: true, participant: JID, ...key },
        message: { conversation: "hola" },
        messageType: "conversation",
        ...extra,
      },
    ],
  };
}

describe("E24 · el nombre del remitente (lo que el fork ya enviaba)", () => {
  test("el receptor guarda el pushName que el proveedor envia", () => {
    const [m] = normalizeEvo(delivery({ pushName: "Jaime Villanueva" }), "mini-assistant");
    // Antes: undefined — el nombre se descartaba en la normalizacion.
    expect(m.senderName).toBe("Jaime Villanueva");
    // Y el jid NO se toca: es la identidad, y las dos mitades van juntas.
    expect(m.sender).toBe(JID);
  });

  test("una entrega sin pushName sigue siendo valida (el fork no siempre lo trae)", () => {
    const [m] = normalizeEvo(delivery(), "mini-assistant");
    expect(m.senderName).toBeUndefined();
    expect(m.sender).toBe(JID);
  });

  test("un pushName inservible se descarta, pero el mensaje NO se pierde", () => {
    for (const bad of ["", "   ", "con\nsalto", "con\ttabulacion", "nulo\0byte", 42, null, { a: 1 }]) {
      const [m] = normalizeEvo(delivery({ pushName: bad }), "mini-assistant");
      expect(m.senderName).toBeUndefined();
      // La entrega con una etiqueta rota se acepta igual: una etiqueta jamas
      // puede costar el mensaje que etiqueta.
      expect(m.text).toBe("hola");
    }
  });

  test("el nombre se acota: un 'nombre' de 300 caracteres no es un nombre", () => {
    const [m] = normalizeEvo(delivery({ pushName: "N".repeat(300) }), "mini-assistant");
    expect(m.senderName!.length).toBe(64);
  });
});

describe("E24 · el nombre es etiqueta, nunca identidad", () => {
  const dir = mkdtempSync(join(tmpdir(), "e24-identity-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  try {
    test("un remitente NO autorizado sigue rechazado aunque traiga un nombre", () => {
      inbox.bind({
        channel: "whatsapp",
        account: "mini-assistant",
        thread: GROUP,
        session: "wa-e24",
        project: "/tmp",
        allowedSenders: [JID],
      });
      const [byJid] = normalizeEvo(delivery({ pushName: "Jaime Villanueva" }), "mini-assistant");
      expect(() => inbox.accept(byJid)).not.toThrow();

      const [impostor] = normalizeEvo(
        delivery({ pushName: "Jaime Villanueva" }, { participant: "999999999999@lid", id: "E24-2" }),
        "mini-assistant",
      );
      // El nombre dice "Jaime" y el jid no es el suyo: la identidad la decide el
      // jid, que es justo lo que este arreglo tiene que seguir siendo cierto.
      expect(() => inbox.accept(impostor)).toThrow();
    });

    test("renombrarse no convierte una reentrega en contenido distinto", () => {
      // Mismo id y mismo texto, nombre nuevo: es la MISMA entrega reintentada.
      // Si el nombre entrase en la comparacion, el renombrado rechazaria el
      // mensaje por una etiqueta.
      const [first] = normalizeEvo(delivery({ pushName: "Nombre Viejo" }), "mini-assistant");
      const one = inbox.accept(first);
      const [again] = normalizeEvo(delivery({ pushName: "Nombre Nuevo" }), "mini-assistant");
      const two = inbox.accept(again);
      expect(two.duplicate).toBe(true);
      expect(two.seq).toBe(one.seq);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("E24 · el espejo lleva el nombre hasta la web", () => {
  const dir = mkdtempSync(join(tmpdir(), "e24-mirror-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  const mirror = new MirrorStore(inbox.db);
  try {
    inbox.bind({
      channel: "whatsapp",
      account: "mini-assistant",
      thread: GROUP,
      session: "wa-e24",
      project: "/tmp",
      allowedSenders: [JID],
    });
    const [m] = normalizeEvo(delivery({ pushName: "Jaime Villanueva" }), "mini-assistant");
    const row = inbox.accept(m);
    const id = mirror.append({
      inboxSeq: row.seq,
      session: row.session,
      channel: "whatsapp",
      account: "mini-assistant",
      thread: GROUP,
      messageId: m.messageId,
      sender: m.sender,
      senderName: m.senderName,
      sentAt: m.sentAt,
      text: m.text,
      attachments: [],
    });
    const back = mirror.forSession("wa-e24");
    expect(id).not.toBeNull();
    expect(back[0]!.senderName).toBe("Jaime Villanueva");
    // El evento de cable que el navegador dibuja lleva las dos mitades.
    const event = mirrorEvent(back[0]!, () => null);
    expect(event.senderName).toBe("Jaime Villanueva");
    expect(event.sender).toBe(JID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("E24 · el agente recibe quien escribe, no un numero", () => {
  test("el prompt da el nombre Y el jid (la etiqueta sola no es identidad)", () => {
    const prompt = turnPrompt({
      channel: "whatsapp",
      account: "mini-assistant",
      thread: GROUP,
      messageId: "E24-3",
      sender: JID,
      senderName: "Jaime Villanueva",
      sentAt: 1,
      text: "hola",
      attachments: [],
    });
    expect(prompt).toContain("Jaime Villanueva");
    expect(prompt).toContain(JID);
  });

  test("sin nombre el prompt sigue siendo exactamente el de antes", () => {
    const prompt = turnPrompt({
      channel: "whatsapp",
      account: "mini-assistant",
      thread: GROUP,
      messageId: "E24-4",
      sender: JID,
      sentAt: 1,
      text: "hola",
      attachments: [],
    });
    expect(prompt).toContain(`sender ${JID}]`);
  });
});

