import { docs } from "$lib/docs-data";
import { diagrams } from "$lib/diagrams-data";
import { DESCRIPTION, NAME, REPO, abs } from "$lib/site";

export const prerender = true;

/** llms.txt: a short, structured map of the site for language-model crawlers (https://llmstxt.org). */
export const GET = () => {
  const lines = [
    `# ${NAME}`,
    "",
    `> ${DESCRIPTION}`,
    "",
    "## Docs",
    ...docs.map((d) => `- [${d.title}](${abs(`/docs/${d.slug}/`)}): ${d.description}`),
    "",
    "## Diagrams",
    ...diagrams.map((d) => `- [${d.title}](${abs(`/diagrams/${d.id}/`)}): ${d.question ?? d.summary ?? ""}`),
    "",
    "## Project",
    `- [Web app](${abs("/web-app/")}): what the browser UI does`,
    `- [Changelog](${abs("/changelog/")}): release notes`,
    `- [Source code](${REPO}): GitHub repository`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
};
