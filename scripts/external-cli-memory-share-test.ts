import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureExternalCliMemoryAssets } from "../src/main/memory/ExternalCliMemoryAssets";
import { projectMyBuddySkillsToCliRoots } from "../src/main/terminal/HerdrLauncher";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-external-cli-share-"));
try {
  ensureExternalCliMemoryAssets(join(sandbox, ".mybuddy"));
  const sourceRoot = join(sandbox, ".mybuddy", "skills");
  const source = join(sourceRoot, "shared-memory");
  const roots = [join(sandbox, ".agents", "skills"), join(sandbox, ".claude", "skills"), join(sandbox, ".hermes", "skills")];
  assert(existsSync(join(source, "SKILL.md")), "fresh install must materialize shared-memory Skill");

  const first = projectMyBuddySkillsToCliRoots(sourceRoot, roots);
  assert.deepEqual(first.errors, []);
  assert.equal(first.created, 3);
  for (const root of roots) {
    const target = join(root, "shared-memory");
    assert(existsSync(join(target, "SKILL.md")), `${target} must expose shared-memory`);
    assert.equal(resolve(realpathSync(target)), resolve(realpathSync(source)), `${target} must point to MyBuddy source Skill`);
  }

  const second = projectMyBuddySkillsToCliRoots(sourceRoot, roots);
  assert.equal(second.created, 0);
  assert.equal(second.existing, 3);
  assert.deepEqual(second.errors, []);
  console.log("external-cli-memory-share-test: PASS", second);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
