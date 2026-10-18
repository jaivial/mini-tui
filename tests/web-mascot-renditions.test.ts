/**
 * E29. La mascota ocupaba el 11,8% de una primera visita: 30 774 B para un adorno de
 * 56 px.
 *
 * MEDIDO contra el build DESPLEGADO (Chrome 145, perfil limpio, bytes de
 * `transferSize` de Resource Timing — los de `encodedDataLength` de CDP mienten con el
 * memo de E25):
 *
 *   - Una visita nueva baja **261 051 B en 46 peticiones**, y el fichero mas grande
 *     despues de `App-*.js` y de las dos fuentes era **`/mascots/float.webp`: 30 774 B**.
 *     El iniciador es `img`, no el CSS, y se pide en `initiatorType: "img"`.
 *   - Ese fichero es un PNG-matte de **593x560**, y lo pintaba un `Mascot.svelte` de
 *     **56x56 CSS px**: el navegador decodificaba 332 080 pixeles para ensenar 3 136, un
 *     **10,6x de mas**. El `float.webp` era ademas el unico `img` de la visita que no
 *     era un SVG de 1 532 B.
 *   - El coste no era hipotetico: la imagen es decorativa y `aria-hidden`, o sea que el
 *     usuario nunca la puede mirar de cerca. Todo lo que se ahorra aqui es peso que
 *     compite con el bundle por el ancho de banda de la primera visita.
 *
 * El arreglo NO es "no la cargues": la mascota SI pertenece a la primera visita (es lo que
 * la barra lateral pinta en la sala vacia, sin sesion y con sesion), asi que sacarla al
 * primer uso como los paneles habria costado un hueco en el pintado. Es "no la cargues
 * en 560 px": una version cuadrada por densidad (56/112/168) y `srcset`, para que el
 * navegador elija.
 *
 * Estas aserciones leen el fuente y el dist. Sujetan la REGLA (una rendition por
 * densidad, cuadrada, del tamano que se pinta, y los maestros fuera del camino servido)
 * y no el nombre de un fichero: si alguien reintroduce un `import` que trae el master,
 * estas aserciones no lo cazan, y por eso el A/B en vivo de abajo importa.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
}

const WEB = join(import.meta.dir, "..", "web");
const MASCOT_DIR = join(WEB, "public", "mascots");
const MASTER_DIR = join(WEB, "assets", "mascot-master");

/** The moods the app maps, from the module itself. */
const MOODS = ["float", "laptop", "headset", "sleep", "celebrate", "coffee", "wave", "point"] as const;
const DENSITIES = [56, 112, 168] as const;

describe("E29 — mascot renditions", () => {
  test("every mood ships one square rendition per density", () => {
    for (const mood of MOODS) {
      for (const px of DENSITIES) {
        const path = join(MASCOT_DIR, `${mood}-${px}.webp`);
        expect(existsSync(path), `falta ${mood}-${px}.webp`).toBe(true);
      }
    }
  });

  test("a rendition is never served wider than 3x of the 56px box", () => {
    // The defect was one file at 593px. Anything above 168 in the served path means the
    // masters came back.
    for (const entry of readdirSync(MASCOT_DIR)) {
      if (!entry.endsWith(".webp")) continue;
      expect(entry, `${entry} esta en el camino servido y no es una rendition`).toMatch(
        /^(float|laptop|headset|sleep|celebrate|coffee|wave|point)-(56|112|168)\.webp$/,
      );
    }
  });

  test("the 560px masters are kept but are NOT anywhere under public/", () => {
    // Vite copies public/ into dist verbatim, so "not referenced" is not enough: a
    // master left inside public/ gets deployed and served at 30 774 B a piece.
    for (const mood of MOODS) {
      expect(existsSync(join(MASTER_DIR, `${mood}.webp`)), `el master de ${mood} se perdio`).toBe(true);
      expect(existsSync(join(MASCOT_DIR, `${mood}.webp`)), `${mood}.webp volvio a servirse`).toBe(false);
    }
    expect(existsSync(join(MASCOT_DIR, "master")), "master/ volvio a public/").toBe(false);
  });

  test("the whole set is a fraction of what one master used to cost", () => {
    // Before: the pet that a first visit downloaded ALONE was 30 774 B. Now the largest
    // rendition must be well under that, or the srcset buys nothing.
    const biggest = Math.max(
      ...MOODS.flatMap((mood) => DENSITIES.map((px) => statSync(join(MASCOT_DIR, `${mood}-${px}.webp`)).size)),
    );
    expect(biggest, `la rendition mas grande pesa ${biggest} B`).toBeLessThan(30_774);
    // And the 1x rendition — what a DPR-1 desktop actually downloads — must be far below it.
    const oneX = Math.max(...MOODS.map((mood) => statSync(join(MASCOT_DIR, `${mood}-56.webp`)).size));
    expect(oneX, `la rendition 1x mas grande pesa ${oneX} B`).toBeLessThan(6_000);
  });

  test("Mascot.svelte lets the browser pick the density", () => {
    const svelte = read("web", "src", "lib", "components", "Mascot.svelte");
    expect(svelte).toContain("srcset={petSrcset(mood)}");
    // `sizes` names the box exactly: it is a fixed pixel size, so there is nothing to guess.
    expect(svelte).toContain('sizes="{size}px"');
    // The intrinsic ratio must be declared too, or the box reserves the wrong space.
    expect(svelte).toContain("width={size}");
    expect(svelte).toContain("height={size}");
  });

  test("the module derives exactly the widths the files on disk carry", async () => {
    // The VALUES, not the source text: asserting the shape of the code (or even that a
    // `[1,2,3]` literal is still there) breaks the moment the code is rewritten for an
    // unrelated reason. What must hold is that the module and the directory agree.
    const { PET_SIZE, PET_WIDTHS, petSrcset, petSrc } = await import(
      "../web/src/lib/mascot.ts"
    );
    expect(PET_SIZE).toBe(56);
    expect([...PET_WIDTHS]).toEqual([...DENSITIES]);
    expect(petSrcset("idle")).toBe(
      "/mascots/float-56.webp 56w, /mascots/float-112.webp 112w, /mascots/float-168.webp 168w",
    );
    // Every URL the module can emit must be a file that exists: this is what catches a
    // mood renamed or a width added without regenerating.
    for (const mood of ["idle", "thinking", "speaking", "offline", "happy", "break", "wave", "point"] as const) {
      for (const url of [...petSrcset(mood).split(", ").map((u) => u.split(" ")[0]), petSrc(mood)]) {
        const name = url.replace("/mascots/", "");
        expect(existsSync(join(MASCOT_DIR, name)), `${name} no existe pero el modulo lo emite`).toBe(true);
      }
    }
    // The fallback is the DENSEST, so a browser that ignores srcset gets a sharp image.
    expect(petSrc("idle")).toBe("/mascots/float-168.webp");
  });

  test("the generator is runnable and reports no drift", async () => {
    // A checked-in rendition set that the script would rewrite is a set nobody regenerated.
    const script = read("web", "scripts", "gen-mascots.py");
    expect(script).toContain("--check");
    const { spawnSync } = await import("node:child_process");
    const which = spawnSync("which", ["cwebp"], { encoding: "utf8" });
    // cwebp is not installed everywhere (CI, a bare container); the check needs it to rebuild,
    // and skipping the assertion is honest rather than a fake pass.
    if (which.status !== 0) return;
    const out = spawnSync("python3", [join(import.meta.dir, "..", "web", "scripts", "gen-mascots.py"), "--check"], {
      encoding: "utf8",
    });
    expect(out.status === 0 ? "" : `${out.stdout}${out.stderr}`, "las rendiciones derivan del master").toBe("");
  });
});
