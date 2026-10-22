export function match(pattern, path) {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    if (seg.startsWith(":")) {
      if (i >= s.length) return null;
      params[seg.slice(1)] = p[i];
    } else if (seg === "*rest") {
      params.rest = s.slice(i).join(",");
      return params;
    } else {
      if (seg !== s[i]) return null;
    }
  }
  if (s.length > p.length) return null;
  return params;
}
