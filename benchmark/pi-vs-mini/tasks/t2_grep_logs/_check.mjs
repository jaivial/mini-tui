import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2] + "/cart.js").href);
const Cart = mod.Cart ?? mod.default?.Cart;
const t = (cents, want) => {
  const c = new Cart(); c.add("x", cents, 1);
  if (c.total() !== want) { console.log(`FAIL subtotal ${cents} -> ${c.total()} (want ${want})`); process.exit(1); }
};
t(99, 99); t(100, 95); t(199, 189); t(200, 180); t(100000, 90000);
console.log("PASS");
