import { error } from "@sveltejs/kit";
import { diagramById, diagrams } from "$lib/diagrams-data";
import { layout } from "$lib/diagram";
import type { EntryGenerator, PageLoad } from "./$types";

export const entries: EntryGenerator = () => diagrams.map((d) => ({ id: d.id }));

export const load: PageLoad = ({ params }) => {
  const diagram = diagramById(params.id);
  if (!diagram) error(404, "Not found");
  return { diagram, laid: layout(diagram) };
};
