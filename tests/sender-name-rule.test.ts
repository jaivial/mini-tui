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


describe("E24 · la regla tiene que correr DONDE corre la web", () => {
  // Este modulo lo importa el servidor (Bun) Y lo empaqueta el navegador. La
  // primera version usaba `Buffer.byteLength`: verde en los 1308 tests del
  // servidor y, en el navegador, `ReferenceError: Buffer is not defined` al
  // cargar el modulo — es decir, el transcript ENTERO caido, con el servidor
  // sirviendoelo todo bien. Lo que no se puede probar con Bun es que el modulo
  // no dependa de algo que el navegador no tiene: eso se sujeta aqui, leyendo
  // el fuente, porque un `import` de este fichero solo se ejecuta bajo Bun.
  test("el modulo no usa Buffer (no existe en el navegador)", () => {
    const source = readFileSync(new URL("../src/channels/senderName.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Buffer\./);
    // Y lo que usa en su lugar existe en los DOS runtimes.
    expect(source).toMatch(/TextEncoder/);
  });

  test("el modulo no usa ninguna otra API de Node", () => {
    const source = readFileSync(new URL("../src/channels/senderName.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/require\(|process\.|node:/);
    // Ni importa nada: un modulo sin imports es importable desde el navegador
    // sin que Vite tenga que resolver nada del lado del servidor.
    expect(source).not.toMatch(/^import /m);
  });

  test("la cuenta de bytes que usa la regla es la misma en los dos runtimes", () => {
    // TextEncoder mide UTF-8, que es lo que hace Buffer.byteLength; si divergen
    // el mismo nombre pasaria en el servidor y caeria en la web (o al reves).
    const value = "Jaime Villanueva";
    expect(new TextEncoder().encode(value).length).toBe(Buffer.byteLength(value));
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
