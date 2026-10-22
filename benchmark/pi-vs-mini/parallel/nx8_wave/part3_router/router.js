import { match } from "./match.js";

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); }
  handle(method, path) {
    for (const r of this.routes) {
      const params = match(r.pattern, path);
      if (params !== null) return r.handler(params);
    }
    return "404";
  }
}
