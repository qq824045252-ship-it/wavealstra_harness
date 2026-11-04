import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Seed a full, portable skill package. Preserve user/Magpie copies and disable flags. */
export function ensureOfficeCliSkill(source: string, skillsDir: string): "created" | "preserved" {
  const target = join(skillsDir, "officecli");
  if (existsSync(target)) return "preserved";
  if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Bundled OfficeCLI skill missing: ${source}`);
  mkdirSync(skillsDir, { recursive: true });
  const staged = join(skillsDir, `.officecli-${process.pid}.tmp`);
  try {
    cpSync(source, staged, { recursive: true });
    // Read before publish: incomplete packages must never become discoverable.
    readFileSync(join(staged, "references", "cli-operations.md"), "utf8");
    writeFileSync(join(staged, "_user_meta.json"), JSON.stringify({ source: "builtin-officecli", installedAt: Date.now() }));
    renameSync(staged, target);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return "created";
}
