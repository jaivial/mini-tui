// `bun run sync-skills`: import the ~/.claude/skills that mini-tui does not have yet
// (also runs on every mini-tui startup and after `bun install`).
import { CLAUDE_SKILLS_DIR, syncSkills } from "../src/skills";

const { added, dir } = syncSkills();
console.log(added.length ? `mini-tui: imported ${added.length} skill(s) from ${CLAUDE_SKILLS_DIR} into ${dir}: ${added.join(", ")}` : `mini-tui: skills in ${dir} are up to date`);
