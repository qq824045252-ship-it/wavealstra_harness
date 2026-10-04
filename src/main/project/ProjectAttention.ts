/**
 * ProjectAttentionTracker — 项目注意度（Attention）跟踪器。
 *
 * 语义：从现有状态派生（health/blockers/atRisk/待确认数），不新建真源；
 * 事件驱动（由业务变更 handler 触发 onChange），不轮询、不后台执行任何动作；
 * 指纹去重（相同派生结果不重复广播）；seen 确认（用户确认当前指纹后不高亮，
 * 状态变化后自动重新未确认）；源消失/恢复自动收敛（派生即当前状态）。
 * 注意度只反映“当前真实状态”，永不做模型猜测。ack 状态为内存态（重启后重新未确认）。
 */
import { createHash } from "node:crypto";
import type {
  ProjectAttentionDigestDto,
  ProjectHealthLevel,
} from "../../shared/project-domain";
import type { ProjectService } from "./ProjectService";

export class ProjectAttentionTracker {
  /** projectId → 最近广播指纹（去重） */
  private readonly lastFingerprint = new Map<string, string>();
  /** projectId → 已确认指纹（seen 语义） */
  private readonly ackedFingerprint = new Map<string, string>();

  constructor(private readonly projects: ProjectService) {}

  /**
   * 计算注意度（只读派生；不写任何业务数据）。
   * now 可注入（测试确定性）。
   */
  computeDigest(projectId: string, now = Date.now()): ProjectAttentionDigestDto | null {
    let snapshot;
    try {
      snapshot = this.projects.buildStatusSnapshot(projectId, now);
    } catch {
      return null; // 项目不存在/归档不可读等
    }
    let proposals: ReturnType<ProjectService["listActionProposals"]> = [];
    try {
      proposals = this.projects.listActionProposals(projectId);
    } catch {
      proposals = [];
    }
    // 建议层严格 recommendation-only；字段暂留在 DTO，当前运行时恒为 0。
    const executableProposals = 0;
    const needsConfirmation = proposals.filter(
      (p) => p.actionType === "needs_confirmation" && p.status === "proposed",
    ).length;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          health: snapshot.health,
          blockers: snapshot.blockers.length,
          atRisks: snapshot.atRisks.length,
          executableProposals,
          needsConfirmation,
          proposalsTotal: proposals.length,
        }),
      )
      .digest("hex")
      .slice(0, 16);
    return {
      projectId,
      generatedAt: now,
      health: snapshot.health as ProjectHealthLevel,
      blockerCount: snapshot.blockers.length,
      atRiskCount: snapshot.atRisks.length,
      executableProposals,
      needsConfirmation,
      proposalsTotal: proposals.length,
      fingerprint,
      seen: this.ackedFingerprint.get(projectId) === fingerprint,
    };
  }

  /**
   * 业务变更触发：重算注意度；仅当指纹与上次广播不同才返回（去重）。
   * 返回 null = 无变化/项目不可读。
   */
  onChange(projectId: string, now = Date.now()): ProjectAttentionDigestDto | null {
    const digest = this.computeDigest(projectId, now);
    if (!digest) return null;
    if (this.lastFingerprint.get(projectId) === digest.fingerprint) return null;
    this.lastFingerprint.set(projectId, digest.fingerprint);
    return digest;
  }

  /** 初始拉取：返回当前注意度并记录指纹（后续变化才能 diff） */
  getAttention(projectId: string, now = Date.now()): ProjectAttentionDigestDto | null {
    const digest = this.computeDigest(projectId, now);
    if (!digest) return null;
    this.lastFingerprint.set(projectId, digest.fingerprint);
    return digest;
  }

  /** 用户确认当前注意度（seen=true；下次指纹变化重新未确认） */
  acknowledge(projectId: string, now = Date.now()): ProjectAttentionDigestDto | null {
    const digest = this.computeDigest(projectId, now);
    if (!digest) return null;
    this.ackedFingerprint.set(projectId, digest.fingerprint);
    this.lastFingerprint.set(projectId, digest.fingerprint);
    return { ...digest, seen: true };
  }
}
