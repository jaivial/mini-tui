/**
 * E26. Las tres familias de fuentes到达 el navegador por el fichero CSS que bloquea el
 * primer pintado, y ese CSS no debe pesar lo que la app no usa.
 *
 * MEDIDO contra el build DESPLEGADO (Chrome 145), con perfil limpio y los bytes de
 * `loadingFinished` (no los de `responseReceived`, que solo traen cabeceras):
 *
 *   - Una visita de verdad (sin documento de workspace en el servidor) baja
 *     **290 924 B en 45 peticiones**, y de ellos **92 563 B son fuentes: el 31,8%**.
 *     Tres ficheros: Geist latin 29 557, JetBrains Mono latin 40 561, Space Grotesk
 *     latin 22 445.
 *   - El CSS critico traia **una fuente embebida en base64**: el subconjunto
 *     cyrillic-ext de JetBrains Mono (2 028 B), que Vite metió dentro porque su
 *     `assetsInlineLimit` por defecto (4096).inlinea lo que quepa. Medido: el CSS
 *     critico era 16 551 B gzip y el bloque base64 2 388 B de eso, es decir el
 *     **14,4% de la hoja que bloquea el pintado, para un alfabeto que la app nunca
 *     escribe**.
 *   - El paquete se importaba entero (`@fontsource-variable/geist` y companhia), así
 *     que el CSS declaraba **14 bloques @font-face y el dist llevaba 13 ficheros woff2**
 *     para cubrir cirílico, cirílico-extendido, griego y vietnamita junto al latín.
 *     Once de esos ficheros no los pide nunca nadie: el navegador elige subconjunto
 *     por `unicode-range`, y esta app escribe en latín.
 *
 * El arreglo declara a mano solo `latin` + `latin-ext` (los dos que el navegador
 * llegaba a pedir) y pone `assetsInlineLimit: 0` para que una fuente vuelva a ser un
 * fichero. Resultado medido: **6 @font-face, 6 woff2, 0 base64, y el CSS critico de
 * 16 551 a 13 664 B gzip (-2 887 B, -17,4%)**.
 *
 * Estas aserciones leen el fuente, no un DOM: el defecto no es lo que el navegador
 * pintó, es lo que se le hizo descargar antes de pintar. La prueba EN VIVO de que los
 * tres ficheros siguen llegando y el texto sigue saliendo en la cara de la app está en
 * log.md (E26) y en `evidencia/2026-10-17_E26/`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
}

const css = read("web", "src", "app.css");
const vite = read("web", "vite.config.ts");

/** Source with the comments removed: matching raw text would test the prose, not the code. */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The @font-face bodies, comments stripped (a rule inside a comment is not a rule). */
function fontFaces(source: string): string[] {
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...noComments.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
}

const faces = fontFaces(css);

describe("E26 · las fuentes que la app usa, y solo esas", () => {
  test("las tres familias siguen declaradas: quitar el nombre rompe el texto", () => {
    for (const family of ["Geist Variable", "JetBrains Mono Variable", "Space Grotesk Variable"]) {
      expect(faces.filter((f) => f.includes(family)).length).toBeGreaterThan(0);
    }
  });

  test("solo latin y latin-ext: los otros subconjuntos no los pide nunca nadie", () => {
    // El navegador elige por unicode-range. Sin cirílico/griego/vietnamita en el
    // texto, esos ficheros nunca se piden: soloDeadweight en el CSS.
    for (const face of faces) {
      const src = face.match(/url\(([^)]+)\)/)?.[1] ?? "";
      expect(src).toMatch(/(latin|latin-ext)-wght-normal/);
      // Y el rango debe ser el del subconjunto que dice ser, no otro.
      expect(face).toMatch(/unicode-range/);
    }
  });

  test("6 bloques @font-face, ni uno más", () => {
    // 3 familias x 2 subconjuntos. Este número es el que se midió: 14 antes.
    expect(faces.length).toBe(6);
  });

  test("cada familia conserva su eje de pesos variable", () => {
    // Sin esto la app cae a una的重 canned instance: la variable pierde el peso 600
    // de los titulos o el 400 del cuerpo y el texto se ve en el grosor equivocado.
    expect(faces.some((f) => f.includes("Geist Variable") && f.includes("font-weight: 100 900"))).toBe(true);
    expect(faces.some((f) => f.includes("JetBrains Mono Variable") && f.includes("font-weight: 100 800"))).toBe(true);
    expect(faces.some((f) => f.includes("Space Grotesk Variable") && f.includes("font-weight: 300 700"))).toBe(true);
  });

  test("todas con font-display: swap, o el primer pintado espera a la fuente", () => {
    for (const face of faces) expect(face).toMatch(/font-display:\s*swap/);
  });

  test("el latín cubre el castellano: enye, vocales con tilde, diéresis y signos", () => {
    // El motivo de no quedarse con un subconjunto cualquiera. Si alguien quita el
    // rango `latin`, la app sigue arrancando y el castellano cae a la fuente del
    // sistema: justo el fallo que no se ve en un test que no mira los caracteres.
    //
    // Se comprueba la UNION de los dos rangos de cada familia, no cada rango por
    // separado: `latin-ext` no cubre U+00F1 (la enye) y no debe, esa es la
    //划分 del paquete. Lo que tiene que pasar es que el par de subconjuntos, que es
    // lo que el navegador elige entre, cubra el castellano entero.
    const covers = (range: string, cp: number): boolean =>
      range.split(",").some((part) => {
        const p = part.trim().replace(/^U\+/i, "");
        if (p.includes("?")) return cp >= 0 && cp <= 0xff; // `U+??`: forma compacta de U+0000-00FF
        if (p.includes("-")) {
          const [a, b] = p.split("-").map((x) => parseInt(x, 16));
          return cp >= a! && cp <= b!;
        }
        return cp === parseInt(p, 16);
      });

    const CASTELLANO = "ñáéíóúüÑÁÉÍÓÚÜ¿¡";
    for (const family of ["Geist Variable", "JetBrains Mono Variable", "Space Grotesk Variable"]) {
      const mine = faces.filter((f) => f.includes(family));
      expect(mine.length).toBe(2); // latin + latin-ext
      const ranges = mine.map((f) => f.match(/unicode-range:\s*([^;]+)/)?.[1] ?? "");
      for (const ch of CASTELLANO) {
        const cp = ch.codePointAt(0)!;
        expect({ family, ch, covered: ranges.some((r) => covers(r, cp)) })
          .toEqual({ family, ch, covered: true });
      }
    }
  });

  test("nada se embebe en base64 dentro del CSS", () => {
    // El defecto original. Vite inlinea lo que cabe en assetsInlineLimit (4096 por
    // defecto) y el subconjunto cyrillic-ext de JetBrains Mono (2 028 B) cabía: dentro
    // de la hoja que bloquea el pintado, para un alfabeto que nadie escribe aquí.
    expect(css).not.toMatch(/data:font/);
    expect(css).not.toMatch(/data:application\/font/);
  });

  test("vite.config pone assetsInlineLimit: 0, que es lo que impide el embebido", () => {
    // El número por defecto de Vite (4096) es lo que metió la fuente. Sin esto, el
    // fichero más pequeño que se añada mañana vuelve a la hoja de bloqueo.
    expect(vite).toMatch(/assetsInlineLimit:\s*0/);
  });

  test("los import de paquete que traen TODOS los subconjuntos ya no estan", () => {
    // `@import "@fontsource-variable/x"` es la forma que arrastra cirílico y
    // vietnamita. Se lee SIN comentarios: el comentario de arriba cita ese mismo
    // import para explicar por qué disappeared, y contarlo sería medir el texto.
    expect(stripped).not.toMatch(/@import\s+"@fontsource-variable/);
  });

  test("las rutas url() apuntan a los ficheros que existen de verdad", () => {
    // Una ruta mal escrita no falla al compilar: falla en el navegador, con un 404
    // silencioso y el texto cayendo a la fuente del sistema sin ningún error visible.
    const pkg = join(import.meta.dir, "..", "web", "node_modules");
    for (const face of faces) {
      const url = face.match(/url\("([^"]+)"\)/)?.[1];
      expect(url).toBeTruthy();
      if (!url) continue;
      const file = join(pkg, url.replace("@fontsource-variable/", "@fontsource-variable/"));
      expect(Bun.file(file).size).toBeGreaterThan(0);
    }
  });
});

/*
 * El test de arriba mira el FUENTE, y el defecto original no vivía en el fuente: lo
 * producía `vite build`. Por eso hace falta el otro lado: contra el CSS COMPILADO.
 *
 * Un test que solo lee `app.css` pasa contra el build roto sin despeinarse, porque en
 * `app.css` no hay ningún `data:font` — lo pone el bundler. Estos leen `dist/` y se
 * saltan solos si no hay build, para que la suite siga siendo verde en un checkout
 * recién clonado sin `bun install`.
 */
const distAssets = join(import.meta.dir, "..", "web", "dist", "assets");
const built = existsSync(distAssets) ? readdirSync(distAssets).filter((f) => f.endsWith(".css")) : [];
const builtCss = built.map((f) => ({ file: f, text: readFileSync(join(distAssets, f), "utf8") }));

describe.skipIf(builtCss.length === 0)("E26 · contra el CSS ya compilado", () => {
  test("ninguna fuente embebida en base64 en ninguna hoja", () => {
    // El número medido: 1 bloque `data:font` de 2 388 B gzip dentro de la hoja que
    // bloquea el primer pintado. En el build de main sale; con `assetsInlineLimit: 0`
    // la fuente vuelve a ser un fichero y esto no encuentra nada.
    for (const { file, text } of builtCss) {
      expect({ file, inlined: /data:(font|application\/font)/.test(text) })
        .toEqual({ file, inlined: false });
    }
  });

  test("6 bloques @font-face en la hoja crítica, y todos de latin o latin-ext", () => {
    const critical = builtCss.find(({ text }) => (text.match(/@font-face/g) ?? []).length > 0);
    expect(critical).toBeDefined();
    const faces = [...critical!.text.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(faces.length).toBe(6);
    for (const f of faces) expect(f).toMatch(/latin(-ext)?/);
  });

  test("los ficheros woff2 del dist son 6, y todos los que el CSS nombra existen", () => {
    const files = new Set(readdirSync(distAssets).filter((f) => f.endsWith(".woff2")));
    expect(files.size).toBe(6);
    const named = new Set<string>();
    for (const { text } of builtCss) {
      for (const m of text.matchAll(/url\(\/assets\/([^)"']+\.woff2)\)/g)) named.add(m[1]!);
    }
    // Una `url()` a un fichero que no existe es un 404 silencioso: la app arranca y el
    // texto cae a la fuente del sistema sin un solo error visible.
    expect([...named].filter((n) => !files.has(n))).toEqual([]);
  });

  test("la hoja crítica pesa menos que con los catorce @font-face de main", () => {
    // El objetivo, medido en bytes: 16 551 -> 13 664 gzip. La aserción va sobre el
    // margen, no sobre el número exacto: un cambio de Tailwind lo mueve igual de bien
    // que un tipo nuevo de letra, y lo que hay que sujetar es que la hoja que bloquea
    // el pintado no vuelva a engordar por subconjuntos que nadie pide.
    const critical = builtCss.find(({ text }) => (text.match(/@font-face/g) ?? []).length > 0)!;
    const gzip = Bun.gzipSync(Buffer.from(critical.text, "utf8")).byteLength;
    expect(gzip).toBeLessThan(15_000);
  });
});
