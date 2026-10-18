/**
 * E30. Las dos fuentes que una primera visita descarga eran 70 404 B — el 30% del cable —
 * y llevaban dentro un eje de pesos que la app no puede ni pedir.
 *
 * MEDIDO contra el build DESPLEGADO (Chrome 145, perfil limpio, bytes de `transferSize`):
 * una visita nueva baja 233 166 B en 46 peticiones, y tras el bundle de arranque el
 * segundo y el tercer fichero mas grande NO eran CSS ni imagenes sino las fuentes:
 *
 *     /assets/jetbrains-mono-latin-wght-normal.woff2   40 704 B   (17,4% del cable)
 *     /assets/geist-latin-wght-normal.woff2            29 700 B   (12,7% del cable)
 *
 * Eso es cinco veces toda la superficie de API que E29 dejo anotada como siguiente paso
 * (`/api/skills`, 13 911 B). E26 quito los subconjuntos muertos y dejo el ancho del eje
 * intacto: el fichero correcto, con todos sus masters.
 *
 * Y esos masters sobran. Los dos se sirven como VARIABLES con un eje mucho mas ancho que
 * lo que la app pinta:
 *
 *     geist          wght 100..900   (9 masters: Thin..Black)
 *     jetbrains-mono wght 100..800   (7 masters: Thin..ExtraBold)
 *
 * MEDIDO tambien en el navegador, con `getComputedStyle` sobre todos los nodos pintados y
 * todas las declaraciones `font-weight` de las hojas cargadas:
 *
 *     pintado:   geist/400 (171 nodos), geist/500 (49), geist/600 (3), mono/500 (1)
 *     declarado: `font-weight: 600` en cada regla con peso, mas los ejes de @font-face
 *
 * En todo `web/src` las unicas utilidades de peso que existen son `font-medium` (500) y
 * `font-semibold` (600): no hay ni un `font-bold`, `font-extrabold` ni `font-black`. El
 * TECHO es 700, y solo porque `<th>` y `<b>` conservan el `bold` por defecto del
 * navegador dentro de `.prose-mini` — el preflight de Tailwind v4 pone `h1..h6` a
 * `font-weight: inherit` pero no toca `b,strong` ni `th`. El suelo es 400 porque nada
 * pide nada mas ligero.
 *
 * El arreglo fija el eje a 400..700 y regenera los ficheros (`web/scripts/gen-fonts.py`),
 * que tambien reescribe el `font-weight` del CSS para que coincida con el fichero. Ese
 * acoplamiento es la mitad del arreglo: un CSS que promete 100..900 sobre un fichero que
 * solo tiene 400..700 NO da error, simplemente pinta en 700 todo lo que se pase de 700.
 *
 * Estas aserciones leen el fuente y los ficheros, no un DOM: el defecto no es lo que el
 * navegador pinto, es lo que se le hizo descargar antes de pintar. El EJE REAL de cada
 * binario (la tabla `fvar`) lo comprueba `gen-fonts.py --check` con fontTools, que si
 * sabe leerla; aqui se sujeta lo que este repositorio controla. La prueba EN VIVO
 * (bytes reales, y el texto saliendo en la cara de la app) esta en log.md y en
 * `evidencia/2026-10-18_E30/`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "web");
const read = (...parts: string[]): string => readFileSync(join(WEB, ...parts), "utf8");

const css = read("src", "app.css");

/** The @font-face bodies, comments stripped: a rule inside a comment is not a rule. */
function fontFaces(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return [...noComments.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
}

const faces = fontFaces(css);
/** The two families whose upstream axis was wide enough to be worth pinning. */
const PINNED = ["Geist Variable", "JetBrains Mono Variable"];
/** Every weight the app can actually paint, as measured (see the module docstring). */
const PAINTABLE = [400, 500, 600, 700];

describe("E30 · el eje de pesos de las fuentes, ajustado a lo que la app pinta", () => {
  test("el eje del CSS es 400 700 en las dos familias pineadas", () => {
    // El numero medido: 100..900 y 100..800 antes. Space Grotesk se queda en 300 700
    // porque ese es el eje que trae de origen.
    for (const family of PINNED) {
      const mine = faces.filter((f) => f.includes(`"${family}"`));
      expect({ family, faces: mine.length }).toEqual({ family, faces: 2 });
      for (const f of mine) expect(f).toMatch(/font-weight:\s*400\s+700/);
    }
  });

  test("las dos url() de cada familia pineada apuntan al fichero pineado", () => {
    // Un `url()` que sigue nombrando el maestro es el fallo a medias: el CSS pediria un
    // eje de 400..700 sobre un fichero de 100..900, que no es un error sino un archivo
    // de mas en el dist. Y al reves (CSS 100..900 sobre fichero 400..700) es peor:
    // todo lo que pase de 700 se pinta en 700 sin avisar.
    for (const family of PINNED) {
      const pkg = family === "Geist Variable" ? "geist" : "jetbrains-mono";
      for (const f of faces.filter((x) => x.includes(`"${family}"`))) {
        expect(f).toMatch(new RegExp(`url\\("\\.\\./assets/fonts/${pkg}-[a-z-]*-wght-400-700\\.woff2"\\)`));
      }
    }
  });

  test("los ficheros pineados existen y son MAS PEQUENOS que los maestros", () => {
    const dir = join(WEB, "assets", "fonts");
    expect(existsSync(dir)).toBe(true);
    const built = readdirSync(dir).filter((f) => f.endsWith(".woff2"));
    // 2 familias x 2 subconjuntos. Space Grotesk NO esta aqui a proposito.
    expect(built.length).toBe(4);

    for (const file of built) {
      // Y cada uno lo nombra alguna regla del CSS, o es un binario que nadie pide.
      expect(faces.some((f) => f.includes(file))).toBe(true);
      // El nombre del paquete NO es el de la familia CSS: "JetBrains Mono Variable"
      // vive en `@fontsource-variable/jetbrains-mono`. Se deriva del propio nombre de
      // fichero, que si lleva el prefijo del paquete, y se busca por prefijo en vez de
      // reconstruirlo a mano.
      const master = file.replace(/-wght-400-700\.woff2$/, "-wght-normal.woff2");
      const pinnedSize = Bun.file(join(dir, file)).size;
      const masterSize = Bun.file(
        join(WEB, "node_modules", "@fontsource-variable", master.split("-latin")[0]!, "files", master),
      ).size;
      expect({ file, masterBytes: masterSize > 0, pinnedBytes: pinnedSize > 0 }).toEqual({
        file,
        masterBytes: true,
        pinnedBytes: true,
      });
      expect(pinnedSize).toBeLessThan(masterSize);
    }
  });

  test("ninguna utilidad de peso fuera de 400..700 aparece en el codigo de la web", () => {
    // La contraprueba del eje: `font-bold` (700) sigue dentro, pero `font-extrabold`
    // (800) o `font-black` (900) caerian fuera del rango y el texto se pintaria en 700
    // sin que nada lo diga. Esto es lo que avisa ANTES de que lo escriba nadie.
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(svelte|css)$/.test(entry.name)) sources.push(readFileSync(p, "utf8"));
      }
    };
    walk(join(WEB, "src"));

    const body = sources.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const fuera = [...body.matchAll(/font-(thin|extralight|light|black|extrabold)/g)].map((m) => m[1]!);
    expect({ fueraDeRango: [...new Set(fuera)] }).toEqual({ fueraDeRango: [] });

    const sueltos = [...body.matchAll(/font-weight:\s*(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((w) => w > 700);
    expect({ pesosSueltosFuera: sueltos }).toEqual({ pesosSueltosFuera: [] });
  });

  test("Space Grotesk NO se pinea: su eje de origen ya es 300..700", () => {
    // Copiarlo "por simetria" seria anadir un binario y un paso de regeneracion para
    // comprar 36 B: medido, su `latin-ext` pineado salia 36 B MAS grande que el maestro.
    for (const f of faces.filter((x) => x.includes('"Space Grotesk Variable"'))) {
      expect(f).toMatch(/font-weight:\s*300\s+700/);
      expect(f).toMatch(/url\("@fontsource-variable\/space-grotesk\//);
    }
  });

  test("los cuatro pesos que la app pinta caben todos en el eje que queda", () => {
    // El circulo cerrado: los pesos medidos en el navegador tienen que estar dentro del
    // rango que el CSS ofrece. Si el eje se aprieta mas, esto falla; si la app empieza a
    // pedir 800, tambien.
    for (const family of PINNED) {
      const declared = faces
        .filter((f) => f.includes(`"${family}"`))
        .map((f) => f.match(/font-weight:\s*(\d+)\s+(\d+)/)!)
        .filter((m) => m !== null)
        .map((m) => [Number(m[1]), Number(m[2])] as const);
      expect(declared.length).toBe(2);
      const [lo, hi] = declared[0]!;
      expect(declared.every(([a, b]) => a === lo && b === hi)).toBe(true);
      for (const w of PAINTABLE) {
        expect({ family, w, dentro: w >= lo && w <= hi }).toEqual({ family, w, dentro: true });
      }
    }
  });
});
