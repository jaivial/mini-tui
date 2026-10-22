// String toolkit. Several behaviors are wrong or missing: the tests define
// the exact contract. Keep the six export names.

/** "Hello,  World!" -> "hello-world"; keep latin letters/digits, dashes between words. */
export function slugify(s) {
  return s.toLowerCase().replace(/\s+/g, "-");
}

/** Truncate to at most n chars, ending with "..." (which counts toward n). */
export function truncate(s, n) {
  return s.slice(0, n) + "...";
}

/** "hello world foo" -> "helloWorldFoo". */
export function camelCase(s) {
  return s.replace(/ (\w)/g, (m, c) => c.toUpperCase());
}

/** "a=1&b=2&a=3" -> {a: ["1","3"], b: ["2"]} (values always arrays, order kept). */
export function parseQuery(q) {
  const out = {};
  for (const pair of q.split("&")) {
    const [k, v] = pair.split("=");
    out[k] = v;
  }
  return out;
}

/** Replace {name} with params[name]; unknown keys become "undefined". */
export function render(tpl, params) {
  return tpl.replace(/\{\w+\}/g, (m) => params[m]);
}

/** Classic edit distance. */
export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + 1);
  return dp[a.length][b.length];
}
