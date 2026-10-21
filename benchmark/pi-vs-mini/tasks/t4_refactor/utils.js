function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseDuration(str) {
  // accepts "10s", "1m30s", "45ms"
  const m = /^((\d+)h)?((\d+)m)?((\d+(\.\d+)?)s)?((\d+)ms)?$/.exec(str || "");
  if (!m) return null;
  const h = Number(m[2] || 0), mi = Number(m[4] || 0), s = Number(m[6] || 0), ms = Number(m[9] || 0);
  return h * 3600000 + mi * 60000 + s * 1000 + ms;
}

module.exports = { slugify, parseDuration };
