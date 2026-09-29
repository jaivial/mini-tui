import { DESCRIPTION, NAME } from "$lib/site";
import { base } from "$app/paths";

export const prerender = true;
export const GET = () =>
  new Response(
    JSON.stringify({ name: NAME, short_name: NAME, description: DESCRIPTION, start_url: `${base}/`, scope: `${base}/`, display: "browser", background_color: "#161612", theme_color: "#161612", icons: [{ src: `${base}/favicon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" }] }),
    { headers: { "content-type": "application/manifest+json; charset=utf-8" } },
  );
