import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { WorkDto } from "../../../shared/bot-work";
import { newId } from "./WorkRepository";
import type { WorkService } from "./WorkService";

export type CausalDecision = "admitted" | "blocked-loop" | "blocked-depth" | "blocked-hops" | "blocked-budget" | "unknown-attribution";

export interface CausalPolicy {
  maxDepth: number;
  maxHops: number;
  maxDispatches: number;
}

export const DEFAULT_CAUSAL_POLICY: CausalPolicy = { maxDepth: 8, maxHops: 4, maxDispatches: 32 };

export interface CausalAdmissionInput {
  workId: string;
  subscriptionId?: string;
  source: string;
  sourceEventId: string;
  causalEventId?: string;
  parentChainId?: string;
  originWorkId?: string;
  originBotId?: string;
  inputSnapshotId?: string;
  actionKind: string;
  /** Stable operation/message identity for idempotent replay. */
  operationId: string;
  /** Host-verified root: an external fact, user instruction or system trigger. */
  trustedRoot?: boolean;
  budgetAvailable?: boolean;
  targetState?: unknown;
  policy?: Partial<CausalPolicy>;
}

export interface CausalAdmission {
  allowed: boolean;
  chainId: string;
  decision: CausalDecision;
  reasonCode?: "causal-loop-guard" | "causal-depth" | "causal-hops" | "causal-attribution-unknown" | "budget-exhausted";
  message?: string;
  rootEventId: string;
  depth: number;
  hops: number;
  dispatchCount: number;
  targetStateHash: string;
}

interface ChainRow {
  chain_id: string;
  root_event_id: string;
  parent_chain_id: string | null;
  parent_causal_event_id: string | null;
  origin_work_id: string;
  origin_bot_id: string | null;
  target_work_id: string;
  target_subscription_id: string | null;
  source: string;
  source_event_id: string | null;
  input_snapshot_id: string | null;
  target_state_hash: string | null;
  depth: number;
  hops: number;
  dispatch_count: number;
  admission_key: string;
  decision: CausalDecision;
  reason_code: string | null;
  created_at: number;
}

/**
 * One persistent causal ledger for ingress, dispatch, tool results and collaboration.
 *
 * A chain is rooted in a trusted host fact. Same-chain requests for the same business
 * state are refused; legitimate fan-out to another Work or subscription is not globally
 * deduped. Every refusal is itself a durable admission fact, and settlements never call
 * this guard, so exhausting a chain cannot block usage reporting, cleanup or adoption.
 */
export class WorkCausalGuard {
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly options: { now?: () => number } = {}) {}

  private now(): number { return this.options.now ? this.options.now() : Date.now(); }

  policy(work: WorkDto): CausalPolicy {
    return { ...DEFAULT_CAUSAL_POLICY, ...(work.causalPolicy ?? {}) };
  }

  /** Business fingerprint: stable state only, never event ids, timestamps or telemetry. */
  fingerprint(work: WorkDto, targetState?: unknown): string {
    const state = targetState ?? {
      intentRevision: work.intentRevision,
      lifecycle: work.lifecycle,
      inputSnapshotId: work.inputSnapshotId,
      criteria: work.criteria.map(item => [item.id, item.status, item.verifiedIntentRevision ?? null]).sort(),
      accepted: [...work.acceptedDeliverableIds].sort(),
      progress: work.progressSummary ?? "",
      pendingConclusion: work.pendingConclusion ?? null,
    };
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
  }

  admit(input: CausalAdmissionInput): CausalAdmission {
    const now = this.now();
    return this.works.transaction((): CausalAdmission => {
      const work = this.works.getWork(input.workId);
      if (!work) throw new Error("因果准入缺少目标 Work");
      const policy = { ...this.policy(work), ...(input.policy ?? {}) };
      const stateHash = this.fingerprint(work, input.targetState);
      const resolvedParent = this.resolveParent(input, work);
      const parent = resolvedParent === "unknown" ? undefined : resolvedParent;
      const root = parent?.root_event_id ?? `source:${input.source}:${input.sourceEventId}`;
      const depth = parent ? parent.depth + 1 : 0;
      const hops = parent ? parent.hops + 1 : 0;
      const dispatchCount = parent ? parent.dispatch_count + 1 : 1;
      const admissionKey = createHash("sha256").update(JSON.stringify([root, work.workId,
        input.subscriptionId ?? null, work.inputSnapshotId, stateHash, input.operationId])).digest("hex");
      const existing = this.byAdmissionKey(admissionKey);
      if (existing) return this.toResult(existing);

      // Same chain, same business state, new operation identity is a loop, regardless of ids.
      const repeated = this.db.prepare(`SELECT * FROM work_causal_chains WHERE root_event_id=? AND target_work_id=?
        AND COALESCE(target_subscription_id,'')=COALESCE(?,'') AND COALESCE(input_snapshot_id,'')=COALESCE(?,'')
        AND target_state_hash=? AND decision='admitted' LIMIT 1`)
        .get(root, work.workId, input.subscriptionId ?? null, work.inputSnapshotId, stateHash) as ChainRow | undefined;
      let decision: CausalDecision = "admitted";
      let reasonCode: CausalAdmission["reasonCode"];
      let message: string | undefined;
      if (resolvedParent === "unknown") {
        decision = "unknown-attribution";
        reasonCode = "causal-attribution-unknown";
        message = "因果引用无法由宿主证明归属，保留原事实并保守拒绝新增执行";
      } else if (repeated) {
        decision = "blocked-loop";
        reasonCode = "causal-loop-guard";
        message = `同链在同一业务状态再次请求执行（${input.actionKind}），未创建新的业务工作`;
      } else if (input.budgetAvailable === false) {
        decision = "blocked-budget";
        reasonCode = "budget-exhausted";
        message = "共享预算已耗尽，未创建新的业务工作；已有结果与用量仍可结算";
      } else if (depth > policy.maxDepth) {
        decision = "blocked-depth";
        reasonCode = "causal-depth";
        message = `因果深度 ${depth} 超过保存的上限 ${policy.maxDepth}`;
      } else if (hops > policy.maxHops) {
        decision = "blocked-hops";
        reasonCode = "causal-hops";
        message = `专家互调 ${hops} 跳超过保存的上限 ${policy.maxHops}`;
      } else if (dispatchCount > policy.maxDispatches) {
        decision = "blocked-hops";
        message = `同一因果根的全链派发 ${dispatchCount} 次超过上限 ${policy.maxDispatches}`;
      }
      const chainId = newId("chain");
      this.db.prepare(`INSERT INTO work_causal_chains
        (chain_id,root_event_id,parent_chain_id,parent_causal_event_id,origin_work_id,origin_bot_id,
         target_work_id,target_subscription_id,source,source_event_id,input_snapshot_id,target_state_hash,
         depth,hops,dispatch_count,admission_key,decision,reason_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        chainId, root, parent?.chain_id ?? null, input.causalEventId ?? null,
        input.originWorkId ?? parent?.origin_work_id ?? work.workId, input.originBotId ?? parent?.origin_bot_id ?? null,
        work.workId, input.subscriptionId ?? null, input.source, input.sourceEventId,
        work.inputSnapshotId, stateHash, depth, hops, dispatchCount, admissionKey, decision,
        reasonCode ?? null, now,
      );
      if (decision !== "admitted") this.block(work, decision, reasonCode ?? "causal-loop-guard", message ?? decision, chainId, now);
      return { allowed: decision === "admitted", chainId, decision, reasonCode, message, rootEventId: root,
        depth, hops, dispatchCount, targetStateHash: stateHash };
    });
  }

  private resolveParent(input: CausalAdmissionInput, work: WorkDto): ChainRow | "unknown" | undefined {
    if (input.parentChainId) {
      const row = this.byChainId(input.parentChainId);
      if (!row) return "unknown";
      // The host vouches for the parent id; cross-Work handoffs keep one shared chain.
      return row;
    }
    if (input.causalEventId) {
      const row = this.db.prepare(`SELECT * FROM work_causal_chains WHERE chain_id=? OR root_event_id=?
        OR parent_causal_event_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`)
        .get(input.causalEventId, input.causalEventId, input.causalEventId) as ChainRow | undefined;
      if (!row) return "unknown";
      return row;
    }
    // External facts start a new root only when the host vouches for their provenance.
    if (input.trustedRoot === false) return "unknown";
    return undefined;
  }

  /** A tool/action returning into the same chain records a new hop without starting a business dispatch. */
  recordReturn(parentChainId: string, operationId: string, targetState?: unknown): CausalAdmission | undefined {
    const parent = this.byChainId(parentChainId);
    if (!parent) return undefined;
    const work = this.works.getWork(parent.target_work_id);
    if (!work) return undefined;
    return this.admit({ workId: work.workId, subscriptionId: parent.target_subscription_id ?? undefined,
      source: "durable_host", sourceEventId: `return:${operationId}`, parentChainId,
      inputSnapshotId: work.inputSnapshotId, actionKind: "tool-return", operationId,
      trustedRoot: true, targetState });
  }

  list(workId: string, limit = 20): ChainRow[] {
    return this.db.prepare("SELECT * FROM work_causal_chains WHERE target_work_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?")
      .all(workId, limit) as ChainRow[];
  }

  private byChainId(chainId: string): ChainRow | undefined {
    return this.db.prepare("SELECT * FROM work_causal_chains WHERE chain_id=?").get(chainId) as ChainRow | undefined;
  }

  private byAdmissionKey(key: string): ChainRow | undefined {
    return this.db.prepare("SELECT * FROM work_causal_chains WHERE admission_key=?").get(key) as ChainRow | undefined;
  }

  private toResult(row: ChainRow): CausalAdmission {
    return { allowed: row.decision === "admitted", chainId: row.chain_id, decision: row.decision,
      reasonCode: (row.reason_code ?? undefined) as CausalAdmission["reasonCode"], rootEventId: row.root_event_id,
      depth: row.depth, hops: row.hops, dispatchCount: row.dispatch_count,
      targetStateHash: row.target_state_hash ?? "" };
  }

  private block(work: WorkDto, decision: CausalDecision, reasonCode: NonNullable<CausalAdmission["reasonCode"]>,
    message: string, chainId: string, now: number): void {
    const blockerId = `causal:${reasonCode}`;
    const existing = this.works.repo.getBlocker(blockerId);
    const details = { chainId, decision, reasonCode, policy: this.policy(work) };
    if (!existing) {
      this.works.repo.insertBlocker({ blockerId, workId: work.workId, kind: "operational", reasonCode,
        reason: message, details, causalChainId: chainId, waitingForUserInput: false, status: "open", createdAt: now });
    } else {
      this.db.prepare("UPDATE work_blockers SET reason=?,details_json=?,causal_chain_id=?,status='open',cleared_at=NULL WHERE blocker_id=?")
        .run(message, JSON.stringify(details), chainId, blockerId);
    }
    // One projection wakeup per blocked reason, not per rejected event.
    const latest = this.works.getWork(work.workId);
    if (latest && latest.stateVersion === work.stateVersion) {
      this.works.repo.updateWork({ ...latest, stateVersion: latest.stateVersion + 1, updatedAt: now });
    }
  }
}
