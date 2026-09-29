import { pages } from "$lib/routes";
import { sitemapXml } from "$lib/seo";

export const prerender = true;
export const GET = () => new Response(sitemapXml(pages), { headers: { "content-type": "application/xml; charset=utf-8" } });
