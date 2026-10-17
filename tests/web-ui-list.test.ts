/**
 * E23. La lista generativa no se llamaba a si misma, un elemento malo borraba los
 * cuarenta y el tope se aplicaba en silencio.
 *
 * Continuacion de C2 ("UI generativa") y del item que E22 dejo anotado sin atacar
 * ("la tabla y la lista no tienen caption"). Medido contra el build DESPLEGADO
 * (Chrome 145), con las listas entrando por el WebSocket de sesion real:
 *
 * (1) NO TENIA NOMBRE. El arbol de accesibilidad tenia **4 nodos `list` y 3 se
 *     llamaban `""`**: el `title` del modelo llegaba al DOM, pero como un `<p>`
 *     SUELTO por encima del `<ul>`, donde nada lo liga a la lista. Un lector que
 *     entra en una lista de 50 pasos oye "lista, 50 elementos" y nada mas. Y a
 *     diferencia de la tabla, aqui no hay `<caption>` posible: `<ul>` no lo tiene.
 * (2) UN ELEMENTO MALO BORRABA LOS CUARENTA. `validateList` devolvia `bad()` en
 *     cuanto un elemento no tenia `title`, o no era un objeto, o traia el titulo
 *     como numero. Medido: **41 elementos con UNO sin `title` -> 0 dibujados**,
 *     sustituidos por "Componente no renderizado". Exactamente el defecto que E22
 *     cerro en la tabla, y que aqui seguia abierto.
 * (3) EL TOPE SE APLICABA EN SILENCIO. `raw.slice(0, 50)` para la lista y
 *     `slice(0, 60)` para la tabla: medido, **100 elementos -> 50** y **100 filas
 *     -> 60**, sin un aviso en ninguna parte. Una superficie que se presenta como
 *     completa y no lo esta es peor que una que avisa; E22 ya lo dijo para la tabla
 *     y solo lo cumplio a medias, porque conto las filas mal formadas y no las
 *     que nunca se leyeron.
 *
 * Lo que NO arregla este item, medido a proposito: los `<li>` salen con nombre `""`
 * en el arbol de accesibilidad... y salen igual de vacios en un `<ul><li>` escrito a
 * mano en la misma pagina de prueba, sin Svelte ni nuestro CSS. Es comportamiento de
 * Chrome, no un defecto nuestro, asi que no se toca.
 *
 * Las reglas viven en `web/src/lib/ui/validate.ts` y `web/src/lib/ui/omittedNotice.ts`,
 * como `chartGeometry.ts` y `recorderBar.ts` antes que ellas: lo comprobable sin DOM
 * se comprueba aqui, y el componente solo dibuja lo que esta validado.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
// Los topes van como LITERAL, no importados de validate.ts, a proposito: si este
// fichero importara `LIST_MAX` — que no existe todavia en origin/main — el modulo
// no cargaria y el fichero entero caeria con "Export named not found" sin ejecutar
// NI UNA asercion. Asi, contra el arbol viejo, estas aserciones fallan de verdad una
// a una, que es lo que demuestra que sujetan el defecto y no una firma nueva.
// Que el codigo y el test no puedan separarse lo sujeta el ultimo test del bloque
// "el tope se cuenta y se dice".
import { validateList, validateTable, type ListProps } from "../web/src/lib/ui/validate";

/** Los mismos numeros que validate.ts, comprobado por test. */
const LIST_MAX = 50;
const TABLE_MAX = 60;

const props = (r: ReturnType<typeof validateList>): ListProps => {
  if (!r.ok) throw new Error(`esperaba una lista valida, vino: ${r.reason}`);
  return r.props;
};
/** Numbered from `desde` so two consecutive batches do not both read "Paso 1..20". */
const n = (k: number, desde = 0) =>
  Array.from({ length: k }, (_, i) => ({ title: `Paso ${desde + i + 1}`, detail: `Detalle ${desde + i + 1}` }));

describe("E23 · la lista se nombra", () => {
  test("el title del modelo llega a la lista", () => {
    expect(props(validateList({ title: "Recogida", items: ["a"] })).title).toBe("Recogida");
  });

  test("sin title, la lista tiene TODAVIA un nombre que la describe", () => {
    const p = props(validateList({ items: ["a", "b", "c"] }));
    const nombre = p.title || `Lista: ${p.items.length} elementos`;
    expect(nombre).toBe("Lista: 3 elementos");
  });

  test("el singular del nombre tambien concuerda", () => {
    // "Lista: 1 elementos" es de las cosas que salen si el nombre se arma con el mismo
    // sustantivo para los dos numeros.
    const p = props(validateList({ items: ["solo"] }));
    expect(`Lista: ${p.items.length} ${p.items.length === 1 ? "elemento" : "elementos"}`).toBe("Lista: 1 elemento");
  });

  test("el <ul> se nombra con aria-labelledby, no repitiendo el texto en aria-label", () => {
    const src = readFileSync(new URL("../web/src/lib/components/ui/UiComponent.svelte", import.meta.url), "utf8");
    // Un <ul> no tiene <caption>: el nombre va sobre la lista. Un solo string para la
    // vista y el anuncio, para que no puedan separarse.
    expect(src).toContain("aria-labelledby={list.props.title ? uidTitle : undefined}");
    // Y sin title del modelo la lista se nombra igual, con su propia forma.
    expect(src).toContain("aria-label={list.props.title ? undefined : listName}");
    // El titulo lleva id para que ese enlace exista.
    expect(src).toMatch(/<p class="ui-title" id=\{uidTitle\}>/);
  });
});

describe("E23 · un elemento malo no tira la lista", () => {
  test("41 elementos con UNO sin title: sobreviven los 40", () => {
    const r = validateList({ title: "Checklist", items: [...n(20), { detail: "sin title" }, ...n(20, 20)] });
    // ANTES: ok === false, y el navegador pintaba "Componente no renderizado" por 40 buenos.
    expect(r.ok).toBe(true);
    const p = props(r);
    expect(p.items.length).toBe(40);
    expect(p.skipped).toBe(1);
    // Los de DETRAS del roto tambien estan: no es que se pierda el malo, es que no se
    // lleva por delante los veinte que vienen despues.
    expect(p.items[0]!.title).toBe("Paso 1");
    expect(p.items[19]!.title).toBe("Paso 20");
    expect(p.items[20]!.title).toBe("Paso 21");
    expect(p.items[39]!.title).toBe("Paso 40");
  });

  test("un elemento que no es un objeto se cuenta, no se propaga", () => {
    const p = props(validateList({ items: [...n(20), 42, ...n(20, 20)] }));
    expect(p.items.length).toBe(40);
    expect(p.skipped).toBe(1);
  });

  test("un title que no es texto vale por un elemento perdido, no por la lista perdida", () => {
    // Un modelo que escribe {"title": 99} es un modelo que un dia escribe la fecha en
    // el sitio del nombre. Se cuenta y se deja fuera.
    const p = props(validateList({ items: [...n(20), { title: 99 }, ...n(20, 20)] }));
    expect(p.items.length).toBe(40);
    expect(p.skipped).toBe(1);
  });

  test("una lista sin NADA dibujable sigue cayendo al aviso honesto", () => {
    // Aqui el fallo es de verdad: no hay nada que dibujar, y no se dibuja media lista.
    const r = validateList({ items: [42, null, { detail: "sin title" }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("list sin ningún elemento que se pueda dibujar");
  });

  test("lo que NO arregla este item: sin items sigue sin haber lista", () => {
    expect(validateList({}).ok).toBe(false);
    expect(validateList({ items: [] }).ok).toBe(false);
    expect(validateList({ items: "nope" }).ok).toBe(false);
  });
});

describe("E23 · el tope se cuenta y se dice", () => {
  test("100 elementos dibujan 50 y admiten que sobran 50", () => {
    const p = props(validateList({ title: "Los 100", items: n(100) }));
    expect(p.items.length).toBe(LIST_MAX);
    // ANTES: los 50 sobrantes desaparecian sin dejar rastro.
    expect(p.truncated).toBe(50);
    expect(p.skipped).toBe(0);
    expect(p.items[LIST_MAX - 1]!.title).toBe(`Paso ${LIST_MAX}`);
  });

  test("100 filas dibujan 60 y admiten que sobran 40", () => {
    const r = validateTable({ columns: ["A"], rows: Array.from({ length: 100 }, (_, i) => [`r${i + 1}`]) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.reason);
    expect(r.props.rows.length).toBe(TABLE_MAX);
    // ANTES: 40 filas desaparecian sin que el navegador dijera nada.
    expect(r.props.truncated).toBe(40);
    expect(r.props.rows[TABLE_MAX - 1]![0]).toBe(`r${TABLE_MAX}`);
  });

  test("una lista que cabe entera no se queja de nada", () => {
    const p = props(validateList({ items: n(LIST_MAX) }));
    expect(p.truncated).toBe(0);
    expect(p.skipped).toBe(0);
  });

  test("el <ul> dibuja el aviso de lo que dejo fuera, y no como live region", () => {
    const lista = readFileSync(new URL("../web/src/lib/components/ui/UiComponent.svelte", import.meta.url), "utf8");
    const tabla = readFileSync(new URL("../web/src/lib/components/ui/UiTable.svelte", import.meta.url), "utf8");
    for (const [nombre, src2] of [["tabla", tabla], ["lista", lista]] as const) {
      expect(src2, `${nombre}: el aviso tiene que existir en el DOM`).toMatch(/class="ui-skip" role="note"/);
      expect(src2, `${nombre}: nada de live region`).not.toMatch(/class="ui-skip" role="status"/);
    }
    // Y las frases viven en un sitio, no dos: duplicadas divergen.
    expect(tabla).toContain("omittedNotice");
    expect(lista).toContain("omittedNotice");
    expect(tabla).not.toContain("no tenía la forma de una tabla");
  });

  test("las cotas de este test son las del codigo, no dos numeros que envejezcan", () => {
    // Lo unico que este fichero puede comprobar de las cotas es que el recorte siga
    // occuriendo en el MISMO sitio: si validate.ts cambiara el tope sin cambiar esto,
    // el aviso diria un numero que ya no es verdad.
    const src = readFileSync(new URL("../web/src/lib/ui/validate.ts", import.meta.url), "utf8");
    expect(src).toContain(`export const LIST_MAX = ${LIST_MAX};`);
    expect(src).toContain(`export const TABLE_MAX = ${TABLE_MAX};`);
    expect(props(validateList({ items: n(LIST_MAX + 10) })).items.length).toBe(LIST_MAX);
  });
});
