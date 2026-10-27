import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMyBuddyDir } from "../paths";
import { ensureExecutableFile } from "../platform/fs-security";
import { getPluginDirectory } from "../plugins/PluginStorage";
import {
  MYBUDDY_MEMORY_CLI,
  MYBUDDY_MEMORY_CMD,
  MYBUDDY_MEMORY_SH,
  SHARED_MEMORY_SKILL,
} from "./external-cli-memory-assets-content";

export interface ExternalCliMemoryAssetsResult {
  skill: "created" | "preserved";
  cli: {
    created: string[];
    updated: string[];
    unchanged: string[];
  };
  skillPath: string;
  binDir: string;
}

function sameContent(path: string, content: string): boolean {
  try {
    return readFileSync(path, "utf-8") === content;
  } catch {
    return false;
  }
}

function writeManagedFile(path: string, content: string, executable = false): "created" | "updated" | "unchanged" {
  if (existsSync(path) && sameContent(path, content)) {
    if (executable) ensureExecutableFile(path);
    return "unchanged";
  }
  const created = !existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", mode: executable ? 0o755 : 0o600 });
    if (executable) ensureExecutableFile(tmp);
    renameSync(tmp, path);
    if (executable) ensureExecutableFile(path);
    return created ? "created" : "updated";
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Materialize the built-in bridge assets needed by external AI CLIs.
 *
 * The shared-memory Skill is user-editable: if either SKILL.md or skill.md already
 * exists, MyBuddy preserves it byte-for-byte. The CLI implementation/wrappers are
 * product-managed files and are refreshed when the bundled implementation changes.
 */
export function ensureExternalCliMemoryAssets(
  myBuddyDir = getMyBuddyDir(),
): ExternalCliMemoryAssetsResult {
  const skillDir = join(getPluginDirectory("skills", myBuddyDir), "shared-memory");
  const skillPath = join(skillDir, "SKILL.md");
  const lowerSkillPath = join(skillDir, "skill.md");
  let skill: ExternalCliMemoryAssetsResult["skill"] = "preserved";
  if (!existsSync(skillPath) && !existsSync(lowerSkillPath)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, SHARED_MEMORY_SKILL, { encoding: "utf-8", mode: 0o600 });
    skill = "created";
  }

  const binDir = join(myBuddyDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const files: Array<{ name: string; content: string; executable?: boolean }> = [
    { name: "mybuddy-memory.mjs", content: MYBUDDY_MEMORY_CLI },
    { name: "mybuddy-memory.cmd", content: MYBUDDY_MEMORY_CMD },
    { name: "mybuddy-memory", content: MYBUDDY_MEMORY_SH, executable: true },
  ];
  const cli = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] };
  for (const file of files) {
    const path = join(binDir, file.name);
    cli[writeManagedFile(path, file.content, file.executable)].push(path);
  }

  return { skill, cli, skillPath: existsSync(skillPath) ? skillPath : lowerSkillPath, binDir };
}
