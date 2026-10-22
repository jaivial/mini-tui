// A working mess. Refactor per SPEC.md.

export function f1(x) {
  // let old = x * 2; // deprecated path
  // old = old + 1;
  // return old;
  let v = x * 100;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}

export function f2(x) {
  let v = x + 5;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return v;
}

export function f3(x) {
  if (Number.isNaN(x)) return 0;
  let v = x;
  if (v < 0) {
    v = 0;
  } else {
    if (v > 100) {
      v = 100;
    }
  }
  return v;
}

export function combine(a, b) {
  return f3(f1(a) + f2(b));
}
