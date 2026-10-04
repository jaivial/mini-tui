// `bun run sync-skills`: install mini-tui's bundled skills (skills/) and import the
// ~/.claude/skills that mini-tui does not have yet (also runs on every startup and after `bun install`).
import { BUNDLED_SKILLS_DIR, CLAUDE_SKILLS_DIR, installBundledSkills, syncSkills } from "../src/skills";

const bundled = installBundledSkills();
const { added, dir } = syncSkills();
const parts: string[] = [];
if (bundled.installed.length) parts.push(`installed ${bundled.installed.join(", ")} from ${BUNDLED_SKILLS_DIR}`);
if (bundled.updated.length) parts.push(`updated ${bundled.updated.join(", ")}`);
if (bundled.kept.length) parts.push(`kept your edited ${bundled.kept.join(", ")}`);
if (added.length) parts.push(`imported ${added.length} skill(s) from ${CLAUDE_SKILLS_DIR}: ${added.join(", ")}`);
console.log(parts.length ? `mini-tui: ${parts.join("; ")} (into ${dir})` : `mini-tui: skills in ${dir} are up to date`);
