// Every route is prerendered to static HTML. `trailingSlash: "always"` makes each page `dir/index.html`,
// which every static host serves without rewrite rules, and gives one canonical URL per page.
export const prerender = true;
export const trailingSlash = "always";
