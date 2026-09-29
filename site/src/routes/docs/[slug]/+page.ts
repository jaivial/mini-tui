import { error } from "@sveltejs/kit";
import { docBySlug, docs, neighbours } from "$lib/docs-data";
import type { EntryGenerator, PageLoad } from "./$types";

// Every doc is prerendered; this tells the crawler which slugs exist.
export const entries: EntryGenerator = () => docs.map((d) => ({ slug: d.slug }));

export const load: PageLoad = ({ params }) => {
  const doc = docBySlug(params.slug);
  if (!doc) error(404, "Not found");
  return { doc, ...neighbours(doc.slug) };
};
