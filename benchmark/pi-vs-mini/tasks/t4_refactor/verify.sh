#!/bin/bash
# utils.js must be ESM (named exports) and parseDuration must reject junk / handle ms-only + h
cd "$(dirname "$0")"
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const m = await import(pathToFileURL(process.cwd() + '/utils.js').href);
const checks = [
  [() => m.slugify('  Hola, Mundo! '), 'hola-mundo'],
  [() => m.parseDuration('90s'), 90000],
  [() => m.parseDuration('1m30s'), 90000],
  [() => m.parseDuration('250ms'), 250],
  [() => m.parseDuration('2h'), 7200000],
  [() => m.parseDuration('junk'), null],
  [() => m.parseDuration(''), null],
  [() => m.parseDuration(undefined), null],
];
for (const [f, want] of checks) {
  const got = f();
  if (got !== want) { console.log('FAIL', f.toString(), '->', got, 'want', want); process.exit(1); }
}
console.log('PASS');
" 2>&1 | tail -2
