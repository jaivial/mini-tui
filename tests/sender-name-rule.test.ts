/**
 * E24 (parte 2). La REGLA de como se lee un remitente, aislada.
 *
 * Este fichero importa el modulo nuevo a proposito, asi que contra `origin/main`
 * muere al importar en vez de caer asercion a asercion. Por eso el otro fichero
 * (`channel-sender-name.test.ts`) no lo importa: el comportamiento se comprueba
 * alli, y aqui se comprueba la regla y que la web la USE en vez de reescribirla.
 *
 * El defecto medido: el fork ya enviaba `pushName` (el atributo `notify` de la
 * stanza) y `normalizeEvo` lo tiraba, de modo que toda identidad circulating
 * por el sistema era un numero de 15 digitos — en la cabecera del transcript, en
 * el arbol de accesibilidad y en el prompt del agente.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { cleanSenderName, senderDisplayName, NAME_MAX } from "../src/channels/senderName";

const JID = "242554100576489@lid";

describe("E24 · la regla unica de como se lee un remitente", () => {
  test("con nombre: el nombre; sin nombre: el jid sin su dominio de ruta", () => {
    expect(senderDisplayName(JID, "Jaime Villanueva")).toBe("Jaime Villanueva");
    expect(senderDisplayName(JID)).toBe("242554100576489");
    expect(senderDisplayName("346000111111@s.whatsapp.net")).toBe("346000111111");
  });

  test("nunca devuelve vacio: un remitente sin nada sigue siendo atribuible", () => {
    expect(senderDisplayName("@lid")).toBe("@lid");
    expect(senderDisplayName("", "")).toBe("");
    expect(senderDisplayName(JID, "")).toBe("242554100576489");
  });

  test("cleanSenderName recorta los bordes y rechaza lo que no es un nombre", () => {
    expect(cleanSenderName("  Ana  ")).toBe("Ana");
    expect(cleanSenderName("")).toBeNull();
    expect(cleanSenderName("   ")).toBeNull();
    expect(cleanSenderName("a\nb")).toBeNull();
    expect(cleanSenderName(undefined)).toBeNull();
    expect(cleanSenderName(7)).toBeNull();
  });
});


describe("E24 · la web usa la MISMA regla (no una copia que derive)", () => {
  // Una copia local ya existia (`sender.replace(/@.*$/,"")`) y es exactamente lo
  // que se queda vieja. Sujetamos que la regla vive en el modulo compartido.
  for (const file of ["Transcript.svelte", "ChannelsSection.svelte"]) {
    test(`${file} usa el modulo compartido`, () => {
      const source = readFileSync(new URL(`../web/src/lib/components/${file}`, import.meta.url), "utf8");
      expect(source).toMatch(/senderDisplayName/);
      expect(source).not.toMatch(/replace\(\/@\.\*\$\/,\s*""\)/);
    });
  }

  test("el tope del modulo es el que el codigo usa (no una constante sistera)", () => {
    const source = readFileSync(new URL("../src/channels/senderName.ts", import.meta.url), "utf8");
    expect(source).toMatch(/slice\(0, NAME_MAX\)/);
    expect(NAME_MAX).toBe(64);
  });
});
