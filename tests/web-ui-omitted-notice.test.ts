/**
 * E23 (parte 2). Las frases que dicen lo que una superficie generativa dejo fuera.
 *
 * Viven aparte de `web-ui-list.test.ts` a proposito: contra `origin/main` este
 * modulo no existe todavia, y un "Cannot find module" cuelga el fichero entero
 * sin ejecutar una sola asercion — no demuestra nada. Aqui vive lo que se puede
 * comprobar contra la validacion que YA existia, y en este las frases.
 *
 * El texto de la tabla es byte a byte el que E22 puso en pantalla: este item no
 * cambia una palabra de lo que el usuario ya leia, solo anade la causa que faltaba.
 */
import { describe, expect, test } from "bun:test";
import { LIST_NOUNS, TABLE_NOUNS, omittedNotice } from "../web/src/lib/ui/omittedNotice";

describe("E23 · como se dice lo que se dejo fuera", () => {
  test("nada omitido: cadena vacia, para que el aviso ni se pinte", () => {
    expect(omittedNotice({ ...LIST_NOUNS, skipped: 0, truncated: 0, cap: 50 })).toBe("");
  });

  test("el aviso nombra las DOS causas, porque son dos dishonestidades distintas", () => {
    expect(omittedNotice({ ...LIST_NOUNS, skipped: 2, truncated: 50, cap: 50 })).toBe(
      "2 elementos no tenían la forma de una lista y se han omitido. Se han omitido 50 elementos más: el máximo que se dibuja es 50.",
    );
  });

  test("singular y plural en las dos frases", () => {
    expect(omittedNotice({ ...TABLE_NOUNS, skipped: 1, truncated: 0, cap: 60 })).toBe(
      "1 fila no tenía la forma de una tabla y se ha omitido.",
    );
    expect(omittedNotice({ ...TABLE_NOUNS, skipped: 5, truncated: 0, cap: 60 })).toBe(
      "5 filas no tenían la forma de una tabla y se han omitido.",
    );
    expect(omittedNotice({ ...LIST_NOUNS, skipped: 0, truncated: 1, cap: 50 })).toBe(
      "Se ha omitido 1 elemento más: el máximo que se dibuja es 50.",
    );
  });

  test("el tope sale dicho, no solo insinuado", () => {
    // "Se han omitido 50 elementos" sin el maximo deja al usuario creyendo que la
    // lista se acabo ahi. El numero del tope es la parte que evita esa lectura.
    expect(omittedNotice({ ...TABLE_NOUNS, skipped: 0, truncated: 40, cap: 60 })).toContain("el máximo que se dibuja es 60");
  });
});
