import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillTrialLedger } from "../src/main/agent/SkillTrialLedger";
import { probeSkillDependency } from "../src/main/agent/SessionDiagnostics";

const root = mkdtempSync(join(tmpdir(), "a2-a3-live-"));
const installed = join(root, "skills", "officecli", "SKILL.md");
mkdirSync(join(root, "skills", "officecli"), { recursive: true });
copyFileSync("scripts/skill-governance/payload/officecli/SKILL.md", installed);
const ledger = new SkillTrialLedger(join(root, "ledger"));
for (const facts of [
  { installed: false, policyAllowed: true, whitelisted: true },
  { installed: true, policyAllowed: false, whitelisted: true },
  { installed: true, policyAllowed: true, whitelisted: false },
]) assert.throws(() => ledger.runOfficeVersion({ ...facts, skillPath: installed, cwd: root }), /denied/);
assert.equal(ledger.latest("officecli", installed, root).state, "unknown");
const dependency = probeSkillDependency("officecli", root, []);
const trial = ledger.runOfficeVersion({ installed: true, policyAllowed: true, whitelisted: true, skillPath: installed, cwd: root });
assert.deepEqual(new SkillTrialLedger(join(root, "ledger")).latest("officecli", installed, root), trial);
writeFileSync(installed, "changed skill");
assert.equal(ledger.latest("officecli", installed, root).state, "unknown");
console.log(JSON.stringify({ root, installation: "temporary local copy of repository skill, not live MyBuddy installation", dependency, trial, persistence: "PASS", policyAdmission: "PASS", changedSkillInvalidation: "PASS" }, null, 2));
