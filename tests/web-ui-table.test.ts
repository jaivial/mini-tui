/**
 * E22. La tabla generativa se llamaba a si misma y una fila mala borraba las 60.
 *
 * Medido contra el build DESPLEGADO (Chrome 145), con las tablas entrando por el
 * WebSocket de sesion real:
 *
 * (1) el arbol de accesibilidad tenia TRES nodos `table` y los tres se llamaban
 *     `""`. Un lector de pantalla que entra en una liquidacion de 60 filas oye
 *     "tabla, 60 filas, 4 columnas" y nada mas. El `title` que escribio el modelo
 *     no llegaba ni al DOM (`validateTable` lo tiraba como clave desconocida), y
 *     `UiTable` no pintaba `<caption>` ni `aria-label`.
 * (2) `validateTable` devolvia `bad()` en cuanto UNA fila no cabia: la fila #3 de
 *     60 con una celda de mas borro las 60 y dejo un "Tabla no renderizada".
 *
 * Estas reglas viven en `web/src/lib/ui/validate.ts`, como `recorderBar.ts` y
 * `chartGeometry.ts` antes que ellas: lo que se puede comprobar sin DOM se comprueba
 * aqui, y el componente solo dibuja lo que esta validado.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateTable, type TableProps } from "../web/src/lib/ui/validate";

const props = (r: ReturnType<typeof validateTable>): TableProps => {
  if (!r.ok) throw new Error(`esperaba una tabla valida, vino: ${r.reason}`);
  return r.props;
};

describe("E22 · la tabla se nombra", () => {
  test("el title del modelo llega a la tabla", () => {
    const p = props(validateTable({ title: "Liquidacion mensual", columns: ["Ruta"], rows: [["R-1"]] }));
    expect(p.title).toBe("Liquidacion mensual");
  });

  test("sin title, la tabla tiene TODAVIA un nombre que la describe", () => {
    // El caption no puede depender de que el modelo haya sido útil: en el build viejo
    // las tres tablas del transcript se llamaban "" y una de ellas no llevaba titulo.
    const p = props(validateTable({ columns: ["Ruta", "Precio"], rows: [["R-1", "1"], ["R-2", "2"]] }));
    expect(p.title).toBeUndefined();
    const caption = p.title || `Tabla: ${p.columns.length} columnas y ${p.rows.length} filas`;
    expect(caption).toBe("Tabla: 2 columnas y 2 filas");
  });

  test("el componente pinta <caption> dentro de <table> y th de fila", () => {
    const src = readFileSync(new URL("../web/src/lib/components/ui/UiTable.svelte", import.meta.url), "utf8");
    // <caption> tiene que ser hijo de <table>, no un <p> de al lado: es el nombre de la
    // tabla en el arbol de accesibilidad, y solo lo es si es su caption.
    expect(src).toMatch(/<table class="ui-table">\s*<caption class="ui-caption">/);
    // La primera columna es la identidad de la fila; sin th scope="row" una celda
    // anuncia "Madrid" sin sujeto.
    expect(src).toMatch(/<th scope="row">/);
    expect(src).toContain('scope="col"');
    // Y no puede quedarse en aria-label sobre el <div> de fuera.
    expect(src).not.toMatch(/aria-label=/);
  });
});

describe("E22 · una fila mala no tira la tabla", () => {
  test("60 filas con la #3 sobredimensionada: sobreviven las 60", () => {
    const columns = ["Ruta", "Origen", "Destino", "Precio"];
    const rows = Array.from({ length: 60 }, (_, i) =>
      i === 2 ? ["R-003", "Madrid", "Barcelona", "58,40 EUR", "EXTRA"] : [`R-00${i + 1}`, "Madrid", "Barcelona", "58,40 EUR"],
    );
    const r = validateTable({ title: "Liquidacion", columns, rows });
    expect(r.ok).toBe(true);
    const p = props(r);
    // ANTES: ok === false, y el navegador pintaba "Tabla no renderizada" por 60 filas buenas.
    expect(p.rows.length).toBe(60);
    expect(p.rows[2]).toEqual(["R-003", "Madrid", "Barcelona", "58,40 EUR"]);
    // La celda de mas no tiene columna donde vivir: se corta, y no se inventa una.
    expect(p.columns.length).toBe(4);
    expect(p.skipped).toBe(0);
  });

  test("una fila que no es una lista se cuenta y se deja fuera, sin perder las demas", () => {
    const r = validateTable({ columns: ["A", "B"], rows: [["1", "2"], "nope", 42, null, ["3", "4"]] });
    const p = props(r);
    expect(p.rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(p.skipped).toBe(3);
  });

  test("una celda que no es texto se cuenta como fila perdida, no como tabla perdida", () => {
    const r = validateTable({ columns: ["A", "B"], rows: [["1", "2"], ["3", { nope: true }]] });
    const p = props(r);
    expect(p.rows).toEqual([["1", "2"]]);
    expect(p.skipped).toBe(1);
  });

  test("el aviso de filas omitidas se dibuja y se anuncia", () => {
    const src = readFileSync(new URL("../web/src/lib/components/ui/UiTable.svelte", import.meta.url), "utf8");
    expect(src).toMatch(/\{#if table\.props\.skipped > 0\}/);
    // `note` y no `status`: un live region anuncia CAMBIOS de contenido, y este aviso se
    // escribe una vez al dibujar la tabla.
    expect(src).toMatch(/class="ui-skip" role="note"/);
    expect(src).not.toMatch(/class="ui-skip" role="status"/);
    // Singular y plural: "1 fila" no es "1 filas".
    expect(src).toContain("fila no tenía la forma de una tabla y se ha omitido");
    expect(src).toContain("filas no tenían la forma de una tabla y se han omitido");
  });

  test("una tabla perfecta no se queja de nada", () => {
    const r = validateTable({ columns: ["A", "B"], rows: [["1", "2"], ["3"]] });
    const p = props(r);
    expect(p.skipped).toBe(0);
    expect(p.rows).toEqual([["1", "2"], ["3", ""]]); // la corta se rellena, como antes
  });

  test("lo que NO arregla este item: sin columnas o sin rows sigue sin haber tabla", () => {
    // El silencio de datos es de las filas, no de la forma general: si no hay cabecera no
    // hay nada que dibujar, y eso sigue siendo un aviso, no media tabla.
    expect(validateTable({ rows: [["1"]] }).ok).toBe(false);
    expect(validateTable({ columns: ["A"] }).ok).toBe(false);
    expect(validateTable({ columns: [], rows: [["1"]] }).ok).toBe(false);
  });

  test("las cotas siguen standing: 8 columnas y 60 filas como maximo", () => {
    const columnas = Array.from({ length: 9 }, (_, i) => `C${i}`);
    const filas = Array.from({ length: 70 }, () => Array.from({ length: 9 }, (_, i) => `v${i}`));
    const p = props(validateTable({ columns: columnas, rows: filas }));
    expect(p.columns.length).toBe(8); // la cola se recorta
    expect(p.rows.length).toBe(60);
    expect(p.rows[0]!.length).toBe(8); // y las celdas de mas con ella
  });
});
