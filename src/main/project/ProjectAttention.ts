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
  ProjectStatusSnapshotDto,
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
    return this.digest(snapshot, this.proposalCounts(projectId));
  }

  private proposalCounts(projectId: string): { needsConfirmation: number; proposalsTotal: number } {
    let proposals: ReturnType<ProjectService["listActionProposals"]> = [];
    try {
      proposals = this.projects.listActionProposals(projectId);
    } catch {
      proposals = [];
    }
    return {
      needsConfirmation: proposals.filter(p => p.actionType === "needs_confirmation" && p.status === "proposed").length,
      proposalsTotal: proposals.length,
    };
  }

  private digest(
    snapshot: ProjectStatusSnapshotDto,
    { needsConfirmation, proposalsTotal }: { needsConfirmation: number; proposalsTotal: number },
  ): ProjectAttentionDigestDto {
    const { projectId, generatedAt } = snapshot;
    const executableProposals = 0;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          health: snapshot.health,
          blockers: snapshot.blockers.length,
          atRisks: snapshot.atRisks.length,
          executableProposals,
          needsConfirmation,
          proposalsTotal,
        }),
      )
      .digest("hex")
      .slice(0, 16);
    return {
      projectId,
      generatedAt,
      health: snapshot.health as ProjectHealthLevel,
      blockerCount: snapshot.blockers.length,
      atRiskCount: snapshot.atRisks.length,
      executableProposals,
      needsConfirmation,
      proposalsTotal,
      fingerprint,
      seen: this.ackedFingerprint.get(projectId) === fingerprint,
    };
  }

  private async readDigest(projectId: string, now: number): Promise<ProjectAttentionDigestDto | null> {
    const previous = this.lastFingerprint.get(projectId);
    try {
      const { snapshot, proposalCounts } = await this.projects.readStatusWithProposalCounts(projectId, now);
      if (this.lastFingerprint.get(projectId) !== previous) return this.computeDigest(projectId, now);
      return this.digest(snapshot, proposalCounts ?? this.proposalCounts(projectId));
    } catch {
      return null;
    }
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

  async readAttention(projectId: string, now = Date.now()): Promise<ProjectAttentionDigestDto | null> {
    const digest = await this.readDigest(projectId, now);
    if (digest) this.lastFingerprint.set(projectId, digest.fingerprint);
    return digest;
  }

  /** 用户确认当前注意度（seen=true；下次指纹变化重新未确认） */
  acknowledge(projectId: string, now = Date.now()): ProjectAttentionDigestDto | null {
    const digest = this.computeDigest(projectId, now);
    return this.recordAcknowledgement(digest);
  }

  async acknowledgeRead(projectId: string, now = Date.now()): Promise<ProjectAttentionDigestDto | null> {
    return this.recordAcknowledgement(await this.readDigest(projectId, now));
  }

  private recordAcknowledgement(digest: ProjectAttentionDigestDto | null): ProjectAttentionDigestDto | null {
    if (!digest) return null;
    const { projectId } = digest;
    this.ackedFingerprint.set(projectId, digest.fingerprint);
    this.lastFingerprint.set(projectId, digest.fingerprint);
    return { ...digest, seen: true };
  }
}
