import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { ensureExternalCliMemoryAssets } from "../src/main/memory/ExternalCliMemoryAssets";
import { prependEnvPath } from "../src/main/terminal/terminal-env";
// 技能写入 <mybuddyDir>/plugins/skills（PluginStorage v1）；旧断言用迁移前的 <mybuddyDir>/skills。
import { getPluginDirectory } from "../src/main/plugins/PluginStorage";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-external-cli-assets-"));
try {
  const sandboxSkills = getPluginDirectory("skills", sandbox);
  const first = ensureExternalCliMemoryAssets(sandbox);
  assert.equal(first.skill, "created");
  assert.equal(first.cli.created.length, 3);
  assert(existsSync(join(sandboxSkills, "shared-memory", "SKILL.md")));
  assert(existsSync(join(sandbox, "bin", "mybuddy-memory.mjs")));
  assert(existsSync(join(sandbox, "bin", "mybuddy-memory.cmd")));
  assert(existsSync(join(sandbox, "bin", "mybuddy-memory")));
  assert.match(readFileSync(join(sandboxSkills, "shared-memory", "SKILL.md"), "utf8"), /name: shared-memory/);
  assert.match(readFileSync(join(sandbox, "bin", "mybuddy-memory.mjs"), "utf8"), /workspace-scoped MyBuddy shared memory/);

  const second = ensureExternalCliMemoryAssets(sandbox);
  assert.equal(second.skill, "preserved");
  assert.equal(second.cli.updated.length, 0);
  assert.equal(second.cli.unchanged.length, 3);

  const skillPath = join(sandboxSkills, "shared-memory", "SKILL.md");
  writeFileSync(skillPath, "# user customized shared-memory\n", "utf8");
  const cliPath = join(sandbox, "bin", "mybuddy-memory.mjs");
  writeFileSync(cliPath, "// stale managed cli\n", "utf8");
  const repaired = ensureExternalCliMemoryAssets(sandbox);
  assert.equal(readFileSync(skillPath, "utf8"), "# user customized shared-memory\n", "user Skill must never be overwritten");
  assert(repaired.cli.updated.includes(cliPath), "managed CLI must self-update");
  assert.match(readFileSync(cliPath, "utf8"), /workspace-scoped MyBuddy shared memory/);

  const lowerRoot = join(sandbox, "lowercase-user-skill");
  const lowerDir = join(getPluginDirectory("skills", lowerRoot), "shared-memory");
  mkdirSync(lowerDir, { recursive: true });
  writeFileSync(join(lowerDir, "skill.md"), "# lowercase user skill\n", "utf8");
  const lower = ensureExternalCliMemoryAssets(lowerRoot);
  assert.equal(lower.skill, "preserved");
  assert.equal(readFileSync(join(lowerDir, "skill.md"), "utf8"), "# lowercase user skill\n", "lowercase user skill is preserved");

  const basePath = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin";
  const env = prependEnvPath({ PATH: basePath }, [first.binDir, first.binDir]);
  const parts = String(env.PATH).split(delimiter);
  assert.equal(resolve(parts[0]), resolve(first.binDir));
  assert.equal(parts.filter((entry) => resolve(entry) === resolve(first.binDir)).length, 1, "PATH entry is unique");

  console.log("external-cli-memory-assets-test: PASS");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
