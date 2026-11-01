import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillReadinessDiagnostic } from "./SessionDiagnostics";

interface TrialRecord {
  schema: 1;
  skillId: string;
  skillHash: string;
  cwd: string;
  trial: SkillReadinessDiagnostic["trial"];
}

/** Explicit local smoke trials only. A version trial proves CLI execution, never Office quality.
 * Evidence is scoped to skill bytes and cwd. No arbitrary shell or model-supplied commands.
 */
export class SkillTrialLedger {
  constructor(private readonly root: string) {}
  private path(id: string, cwd: string): string {
    return join(this.root, createHash("sha256").update(`${id}\0${cwd}`).digest("hex") + ".json");
  }
  latest(id: string, skillPath: string, cwd: string): SkillReadinessDiagnostic["trial"] {
    try {
      const record = JSON.parse(readFileSync(this.path(id, cwd), "utf8")) as TrialRecord;
      const hash = createHash("sha256").update(readFileSync(skillPath)).digest("hex");
      if (record.schema === 1 && record.skillId === id && record.cwd === cwd && record.skillHash === hash
        && ["passed", "failed"].includes(record.trial.state)) return record.trial;
    } catch { /* missing, changed or unreadable evidence is not success */ }
    return { state: "unknown" };
  }
  runOfficeVersion(input: { skillPath: string; cwd: string; installed: boolean; policyAllowed: boolean; whitelisted: boolean }): SkillReadinessDiagnostic["trial"] {
    if (!input.installed || !input.policyAllowed || !input.whitelisted) {
      throw new Error("Skill trial denied: installed, policyAllowed and whitelisted are required");
    }
    const skillHash = createHash("sha256").update(readFileSync(input.skillPath)).digest("hex");
    const at = Date.now();
    let trial: SkillReadinessDiagnostic["trial"];
    try {
      execFileSync("officecli", ["--version"], { cwd: input.cwd, env: process.env, timeout: 2500, maxBuffer: 16384, stdio: ["ignore", "pipe", "pipe"] });
      trial = { state: "passed", at, evidence: "officecli --version exit=0; SKILL.md read; CLI smoke only, no document validation" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "nonzero_or_timeout";
      trial = { state: "failed", at, evidence: `officecli --version failed (${code}); SKILL.md read; no Office quality claim` };
    }
    const path = this.path("officecli", input.cwd);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ schema: 1, skillId: "officecli", skillHash, cwd: input.cwd, trial } satisfies TrialRecord), { mode: 0o600 });
    renameSync(temp, path);
    return trial;
  }
}
