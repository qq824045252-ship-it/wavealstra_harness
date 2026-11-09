import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkActionDescriptor } from "../../../shared/bot-work-action";
import {
  workAutonomyRuleSchema, scopeMatches, type WorkAutonomyRule, type WorkAutonomyOutcome,
  type WorkDecision, workDecisionSchema,
} from "../../../shared/bot-work-autonomy";

const ruleRow = z.object({ rule_json: z.string() });
const decisionRow = z.object({ decision_json: z.string() });

/**
 * 结构化授权记录与规则（P0-C）。普通 Memory 不能在这里授予权限：
 * 只有用户显式保存的规则、或用户对具体动作的决定，才能被复用为兼容先例。
 */
export class WorkDecisionLedger {
  constructor(private readonly db: Database.Database, private readonly now: () => number = () => Date.now()) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_autonomy_rules (
      rule_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bot_id TEXT, decision TEXT NOT NULL,
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
      created_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS work_decisions (
      decision_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, work_id TEXT, bot_id TEXT, action_hash TEXT NOT NULL,
      descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), outcome TEXT NOT NULL, reusable INTEGER NOT NULL,
      decision_json TEXT NOT NULL CHECK(json_valid(decision_json)), created_at INTEGER NOT NULL, superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS work_decisions_lookup ON work_decisions(user_id, action_hash, outcome, reusable);`);
  }

  addRule(input: Omit<WorkAutonomyRule, "ruleId" | "createdAt"> & { ruleId?: string }): WorkAutonomyRule {
    const rule = workAutonomyRuleSchema.parse({ ...input, ruleId: input.ruleId ?? `rule:${randomUUID()}`,
      createdAt: this.now() });
    this.db.prepare(`INSERT INTO work_autonomy_rules(rule_id,user_id,bot_id,decision,scope_json,rule_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(rule.ruleId, rule.userId, rule.botId ?? null, rule.decision,
      JSON.stringify(rule.scope), JSON.stringify(rule), rule.createdAt);
    return rule;
  }

  revokeRule(ruleId: string, userId: string): boolean {
    const result = this.db.prepare("UPDATE work_autonomy_rules SET revoked_at=? WHERE rule_id=? AND user_id=? AND revoked_at IS NULL")
      .run(this.now(), ruleId, userId);
    return result.changes === 1;
  }

  listRules(userId: string): WorkAutonomyRule[] {
    return this.db.prepare("SELECT rule_json FROM work_autonomy_rules WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at")
      .all(userId).map(raw => workAutonomyRuleSchema.parse(JSON.parse(ruleRow.parse(raw).rule_json)));
  }

  record(input: Omit<WorkDecision, "decisionId" | "createdAt" | "policyVersion"> & {
    decisionId?: string; policyVersion: string; supersedes?: string;
  }): WorkDecision {
    const { supersedes, ...rest } = input;
    const decision = workDecisionSchema.parse({ ...rest, decisionId: input.decisionId ?? `decision:${randomUUID()}`,
      createdAt: this.now() });
    this.db.transaction(() => {
      // A corrected decision supersedes the old one but never deletes its history.
      if (supersedes) this.db.prepare("UPDATE work_decisions SET superseded_by=? WHERE decision_id=? AND user_id=?")
        .run(decision.decisionId, supersedes, decision.userId);
      this.db.prepare(`INSERT INTO work_decisions(decision_id,user_id,work_id,bot_id,action_hash,descriptor_json,
        outcome,reusable,decision_json,created_at,superseded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(decision.decisionId, decision.userId, decision.workId ?? null, decision.botId ?? null, decision.actionHash,
          JSON.stringify(decision.descriptor), decision.outcome, decision.reusable ? 1 : 0,
          JSON.stringify(decision), decision.createdAt, decision.supersededBy ?? null);
    })();
    return decision;
  }

  listDecisions(userId: string, limit = 50): WorkDecision[] {
    return this.db.prepare("SELECT decision_json,superseded_by FROM work_decisions WHERE user_id=? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit).map(raw => {
        const row = workDecisionSchema.parse(JSON.parse(decisionRow.parse(raw).decision_json));
        const supersededBy = z.object({ superseded_by: z.string().nullable() }).parse(raw).superseded_by;
        return supersededBy ? { ...row, supersededBy } : row;
      });
  }

  /** 只有明确可复用、未被 supersede、作用域完全兼容的决定才算先例；ignore/expired 不算。 */
  precedentFor(userId: string, descriptor: WorkActionDescriptor, action: {
    effect: string; operation: string; provider?: string; target?: string; environment: string;
    projectId?: string; workspaceId?: string; repo?: string; botId?: string;
  }): WorkDecision | undefined {
    const now = this.now();
    const candidates = this.db.prepare(`SELECT decision_json FROM work_decisions
      WHERE user_id=? AND outcome='allowed' AND reusable=1 AND superseded_by IS NULL
        AND descriptor_json LIKE ? ORDER BY created_at DESC LIMIT 20`).all(userId, `%"effect":"${descriptor.effect}"%`)
      .map(raw => workDecisionSchema.parse(JSON.parse(decisionRow.parse(raw).decision_json)));
    void now;
    void scopeMatches;
    return candidates.find(decision => decision.descriptor.effect === action.effect
      && decision.descriptor.operation === action.operation
      && (decision.descriptor.provider ?? undefined) === (action.provider ?? undefined)
      && (decision.descriptor.target ?? undefined) === (action.target ?? undefined)
      && decision.descriptor.environment === action.environment
      && (decision.scope?.projectId ?? undefined) === (action.projectId ?? undefined)
      && (decision.scope?.repo ?? undefined) === (action.repo ?? undefined)
      && (decision.scope?.workspaceId ?? undefined) === (action.workspaceId ?? undefined)
      && (decision.scope?.botId ?? undefined) === (action.botId ?? undefined));
  }

  /** ignore / timeout 永远不进入先例库，也不作为主人拒绝的负样本。 */
  static readonly nonReusable: readonly WorkAutonomyOutcome[] = ["ignored", "expired"];
}
