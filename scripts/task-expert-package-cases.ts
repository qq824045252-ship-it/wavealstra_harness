import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { ExpertService } from "../src/main/experts/ExpertService";
import { TaskExpertBindingService, type TaskExpertSkillPackage } from "../src/main/experts/TaskExpertBindingService";
import type { TaskExpertSnapshot } from "../src/shared/expert-binding";

export async function verifyTaskExpertPackages(db: AppDatabase, root: string): Promise<void> {
  const reader = db.runtimeAuditReader;
  assert(reader && db.coreIdentity);
  const taskId = "core-task-expert-packages";
  const skillRoot = join(root, "expert-package-bindings");
  const taskRoot = join(skillRoot, createHash("sha256").update(taskId).digest("hex"));
  const privateSkill = join(taskRoot, "active", "private");
  const globalSkill = join(taskRoot, "active", "global");
  mkdirSync(privateSkill, { recursive: true });
  mkdirSync(globalSkill);
  writeFileSync(join(privateSkill, "SKILL.md"), "Original private skill");
  writeFileSync(join(globalSkill, "SKILL.md"), "Original global skill");
  let globalEnabled = true;
  const bindings = new TaskExpertBindingService(db, new ExpertService(), {
    rootDir: skillRoot, isSkillEnabled: () => globalEnabled,
  });
  const active: TaskExpertSnapshot = {
    revision: "original", name: "Original expert", instructions: "Original instructions",
    skillIds: ["private-skill", "global-skill"], mcpIds: [], connectorIds: [],
  };
  const desired: TaskExpertSnapshot = {
    ...active, revision: "pending", name: "Edited expert", instructions: "Edited instructions", skillIds: [],
  };
  const packages: TaskExpertSkillPackage[] = [
    { id: "private-skill", directory: privateSkill, origin: "private" },
    { id: "global-skill", directory: globalSkill, origin: "global" },
  ];
  const activeCopies = JSON.stringify([
    { id: "private-skill", relativePath: join("active", "private"), origin: "private" },
    { id: "global-skill", relativePath: join("active", "global"), origin: "global" },
  ]);
  await db.writeTaskRecord({ id: taskId, title: "Core expert task", updatedAt: Date.now() });
  assert.equal((await reader.writeTaskExpertBinding({ taskId, expectedDesiredJson: null,
    desiredJson: JSON.stringify(active), desiredSkillsJson: activeCopies, expertId: null, at: Date.now() }))?.status, "saved");
  assert.deepEqual(await bindings.readActiveSkillPackages(taskId), []);
  const promote = () => reader.batch2Write({ kind: "taskExpertPromote", taskId, updatedAt: Date.now() });
  assert.deepEqual(await promote(), { ok: true });
  assert.equal((await reader.writeTaskExpertBinding({ taskId, expectedDesiredJson: JSON.stringify(active),
    desiredJson: JSON.stringify(desired), desiredSkillsJson: "[]", expertId: null, at: Date.now() }))?.status, "saved");

  assert.deepEqual(await bindings.readActiveSkillPackages(taskId), packages);
  const state = await reader.readTaskExpertBinding(taskId);
  const binding = state?.binding;
  assert(state && binding);
  assert.deepEqual(bindings.bindingFromState(taskId, state), { taskId, active, desired, pending: true });
  assert.deepEqual(bindings.activeSkillPackagesFromState(taskId, state), packages);
  assert.deepEqual(bindings.skillDirectoriesFromPackages(taskId, packages), [privateSkill, globalSkill]);
  globalEnabled = false;
  const enabled = bindings.skillDirectoriesFromPackages(taskId, await bindings.readActiveSkillPackages(taskId));
  assert.deepEqual(enabled, [privateSkill]);
  assert.equal(readFileSync(join(enabled[0], "SKILL.md"), "utf8"), "Original private skill");
  assert.deepEqual(await bindings.readActiveSkillPackages(taskId), packages);

  assert.throws(() => bindings.activeSkillPackagesFromState("other-task", state), /归属无效/);
  assert.throws(() => bindings.activeSkillPackagesFromState(taskId, { ...state, binding: {
    ...binding, active_skills_json: JSON.stringify([{ id: "escaped", origin: "private", relativePath: join("..", "escaped") }]),
  } }), /路径无效/);
  globalEnabled = true;
  const externalSkill = join(root, "external-to-task-expert");
  renameSync(globalSkill, externalSkill);
  symlinkSync(externalSkill, globalSkill, "junction");
  assert.deepEqual(bindings.skillDirectoriesFromPackages(taskId, packages), [privateSkill]);
  assert.deepEqual(await bindings.readActiveSkillPackages(taskId), packages);

  assert.deepEqual(await promote(), { ok: true });
  assert.deepEqual(await bindings.readActiveSkillPackages(taskId), []);
  assert.deepEqual(bindings.bindingFromState(taskId, await reader.readTaskExpertBinding(taskId) ?? null),
    { taskId, active: desired, desired, pending: false });
  console.log("PASS Core expert packages follow active revisions, task ownership and global skill revocation");
}
