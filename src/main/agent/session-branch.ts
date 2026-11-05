/**
 * session-branch.ts — 对话分支的 Pi session 领域操作（实施规划 §7）。
 *
 * 职责边界：
 * - 用独立 SessionManager 打开源 session（绝不复用/修改 registry 中的 live session）；
 * - 按真实 Pi entry id 在 active branch 中定位分支点（§7.1 评审裁决）；
 * - 物化 root→leaf 的新 session 文件并验证（§7.2）；
 * - 输出 child usage 回填所需的继承段水位（§7.4）。
 *
 * 本模块不做 Task/DB/权限编排——那是 ConversationBranchService 的职责。
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getVisibleSessionUserMessages } from "./session-user-messages";
import type BetterSqlite3 from "better-sqlite3";
import type {
  ConversationBranchPosition,
} from "../../shared/conversation-branch";

/** 领域错误：携带稳定错误码，服务层转成 IPC outcome（§6.2）。 */
import { ConversationBranchDomainError } from "../../shared/conversation-branch";
export { ConversationBranchDomainError } from "../../shared/conversation-branch";

export interface ConversationBranchAnchor {
  /** 主锚点：真实 Pi session entry id（§7.1）。 */
  entryId?: string;
  /** 辅助/回退：过滤后 UI 序号（§7.1，仅在校验与展示时使用）。 */
  userMessageIndex?: number;
  position: ConversationBranchPosition;
}

export interface ResolvedConversationBranchLeaf {
  /** 物化目标 leaf entry id（createBranchedSession 的输入） */
  leafEntryId: string;
  /** 分支点 user message entry id（持久化血缘锚点） */
  userEntryId: string;
  /** Visible UI user index; explicit older active-path anchors retain an audit index. */
  resolvedUserMessageIndex: number;
  /** Native Pi tool-call IDs on root→target leaf; never read synthetic message metadata. */
  inheritedToolCallIds: string[];
}

export interface MaterializedConversationBranchSession {
  sessionFile: string;
  leafEntryId: string;
  /** True only after the child file has been persisted and reopened successfully. */
  persisted: boolean;
  /** 继承段最后一个 entry id（usage 回填水位，§7.4） */
  inheritedLastEntryId: string;
}

/** user message entry 判定（Pi message entry + role=user） */
function isUserMessageEntry(entry: {
  type: string;
  message?: { role?: string };
}): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/**
 * 在 active branch（root→leaf 全量 entry，含 compaction/marker/label）中定位分支点。
 *
 * 主锚点 = entryId：在 active path 精确命中；指定但无效的 ID 必须拒绝。
 * 只有未提供 entryId 时才按当前可见 UI 用户序号回退，失败报
 * ANCHOR_NOT_FOUND / ANCHOR_NOT_IN_ACTIVE_BRANCH。
 *
 * after_reply 的 leaf = 该 user entry 之后、下一条 user entry 之前的最后一个
 * message entry（排除 mybuddy_deleted_user_message marker、label、branch_summary、
 * compaction、thinking_level_change 等非模型上下文条目）；区间内无 message entry
 * 时 leaf 回退到 user entry 自身（§7.2 评审裁决）。
 */
export function resolveConversationBranchLeaf(
  sessionFile: string,
  sourceCwd: string,
  anchor: ConversationBranchAnchor,
): ResolvedConversationBranchLeaf {
  if (!sessionFile || !existsSync(sessionFile)) {
    throw new ConversationBranchDomainError(
      "SESSION_MISSING",
      "源会话文件不存在，无法创建分支。",
    );
  }
  if (anchor.position !== "after_user" && anchor.position !== "after_reply") {
    throw new ConversationBranchDomainError("INVALID_REQUEST", "分支位置无效。");
  }

  // 独立打开：不影响 registry 中的 live session（§7.2-1）
  const sm = SessionManager.open(sessionFile, undefined, sourceCwd);
  const activeBranch = sm.getBranch();
  if (activeBranch.length === 0) {
    throw new ConversationBranchDomainError(
      "ANCHOR_NOT_FOUND",
      "源会话为空，无法创建分支。",
    );
  }

  const visibleUsers = getVisibleSessionUserMessages(sm);

  // ---- 主锚点：稳定 entry id ----
  let userEntryIndex = -1;
  let userEntryId: string | undefined;
  if (anchor.entryId) {
    const idx = activeBranch.findIndex((entry) => entry.id === anchor.entryId);
    if (idx < 0) {
      // entry 存在但不在 active branch（旧弃用支路）→ 明确拒绝；
      // entry 完全不存在 → ANCHOR_NOT_FOUND（§7.1-3）
      const known = sm.getEntries().some((entry) => entry.id === anchor.entryId);
      throw new ConversationBranchDomainError(
        known ? "ANCHOR_NOT_IN_ACTIVE_BRANCH" : "ANCHOR_NOT_FOUND",
        known
          ? "所选消息已不在当前对话分支中，请刷新后重试。"
          : "所选消息已不存在，请刷新后重试。",
      );
    }
    const target = activeBranch[idx];
    if (target.type !== "message") {
      throw new ConversationBranchDomainError(
        "POSITION_MISMATCH",
        "分支点必须是用户消息或助手回合。",
      );
    }
    const role = (target.message as { role?: string }).role;
    if (role === "user") {
      userEntryIndex = idx;
      userEntryId = target.id;
    } else if (role === "assistant" || role === "toolResult") {
      // UI 的助手消息锚点 = 该回合最后一个 message entry；回溯到所属回合的
      // user 起点（§7.1：分支点语义挂在 user 消息上）。
      if (anchor.position === "after_user") {
        throw new ConversationBranchDomainError(
          "POSITION_MISMATCH",
          "所选消息是助手回复，不能按「用户消息之后」创建分支。",
        );
      }
      let start = idx - 1;
      while (start >= 0 && !isUserMessageEntry(activeBranch[start])) start--;
      if (start < 0) {
        throw new ConversationBranchDomainError(
          "ANCHOR_NOT_FOUND",
          "找不到所选消息所属的用户回合，请刷新后重试。",
        );
      }
      userEntryIndex = start;
      userEntryId = activeBranch[start].id;
    } else {
      throw new ConversationBranchDomainError(
        "POSITION_MISMATCH",
        "分支点必须是用户消息或助手回合。",
      );
    }
  }

  // ---- 辅助/回退锚点：过滤后 userMessageIndex（§7.1-3） ----
  // 回退只用于无 entryId 的 live 消息；使用与历史 UI 一致的可见用户序号。
  // userMessageIndex 指向的永远是 user entry，因此 after_user / after_reply 均合法，
  // leaf 由下方统一的 §7.2 计算。
  if (userEntryIndex < 0) {
    const userEntries = visibleUsers.map((visible) => ({
      entry: sm.getEntry(visible.entryId)!,
      index: activeBranch.findIndex((entry) => entry.id === visible.entryId),
    }));
    if (
      typeof anchor.userMessageIndex !== "number" ||
      !Number.isInteger(anchor.userMessageIndex) ||
      anchor.userMessageIndex < 0 ||
      anchor.userMessageIndex >= userEntries.length
    ) {
      throw new ConversationBranchDomainError(
        "ANCHOR_NOT_FOUND",
        "找不到要分支的消息，所选消息可能已不在当前对话中，请刷新后重试。",
      );
    }
    const fallback = userEntries[anchor.userMessageIndex];
    userEntryIndex = fallback.index;
    userEntryId = fallback.entry.id;
  }

  // ---- 计算 leaf（§7.2） ----
  let leafEntryId = userEntryId!;
  if (anchor.position === "after_reply") {
    let nextUserIndex = activeBranch.length;
    for (let i = userEntryIndex + 1; i < activeBranch.length; i++) {
      if (isUserMessageEntry(activeBranch[i])) {
        nextUserIndex = i;
        break;
      }
    }
    // 区间内最后一个 message entry（工具结果也是 message entry，但 assistant
    // 回合的最终答案/工具调用都是 message entry；只排除非上下文类型的 entry）
    for (let i = nextUserIndex - 1; i > userEntryIndex; i--) {
      if (activeBranch[i].type === "message") {
        leafEntryId = activeBranch[i].id;
        break;
      }
    }
  }

  const inheritedBranch = sm.getBranch(leafEntryId);
  return {
    leafEntryId,
    userEntryId: userEntryId!,
    resolvedUserMessageIndex: visibleUsers.findIndex((entry) => entry.entryId === userEntryId) >= 0
      ? visibleUsers.findIndex((entry) => entry.entryId === userEntryId)
      : activeBranch.slice(0, userEntryIndex).filter(isUserMessageEntry).length,
    inheritedToolCallIds: [...new Set(inheritedBranch.flatMap((entry) => {
      if (entry.type !== "message") return [];
      const message = entry.message;
      if (message.role === "toolResult") return [message.toolCallId];
      if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : []);
    }))],
  };
}

/**
 * 物化 child session 文件（§7.2）：
 * - 用目标 cwd override 打开源文件（§7.3：Pi 会把 this.cwd 写进新 header，
 *   从而新文件 header cwd 直接等于 child canonical cwd，无需手工改写 JSONL）；
 * - createBranchedSession(leaf) 浅拷贝 root→leaf 路径（保留原始 entry id，
 *   §7.4 是后面 usage 水位存在的原因）；
 * - 验证新文件：路径不同、parentSession 指向源文件、leaf 存在、leaf 之后
 *   只有 Pi 重生成的 label entries、buildSessionContext 可执行。
 */
export function createConversationBranchSession(
  sourceSessionFile: string,
  targetCwd: string,
  leafEntryId: string,
): MaterializedConversationBranchSession {
  if (!sourceSessionFile || !existsSync(sourceSessionFile)) {
    throw new ConversationBranchDomainError(
      "SESSION_MISSING",
      "源会话文件不存在，无法创建分支。",
    );
  }
  const sourceSm = SessionManager.open(sourceSessionFile, undefined, targetCwd);
  const sourceLeaf = sourceSm.getLeafId();
  const sourceBranch = sourceSm.getBranch();
  if (!sourceLeaf || !sourceBranch.some((entry) => entry.id === leafEntryId)) {
    throw new ConversationBranchDomainError(
      "ANCHOR_NOT_IN_ACTIVE_BRANCH",
      "所选消息已不在当前对话分支中，请刷新后重试。",
    );
  }
  const leafIdx = sourceBranch.findIndex((entry) => entry.id === leafEntryId);
  const sourceEntriesAfterLeaf = sourceBranch.slice(leafIdx + 1);

  let newFile: string | undefined;
  try {
    newFile = sourceSm.createBranchedSession(leafEntryId);
  } catch (err) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      `分支会话物化失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!newFile) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      "分支会话物化失败：源会话未持久化。",
    );
  }
  const absNewFile = isAbsolute(newFile) ? newFile : resolve(newFile);
  if (absNewFile === sourceSessionFile) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      "分支会话物化失败：新会话文件与源文件相同。",
    );
  }

  // createBranchedSession mutates this independent manager to the complete child,
  // including Pi's re-chained entries and regenerated labels. Do NOT seed another
  // session or truncate again at leafId: that drops the labels after that leaf.
  if (!existsSync(absNewFile)) {
    const header = sourceSm.getHeader();
    const entries = sourceSm.getEntries();
    if (!header || entries.some((entry) => entry.type === "message" && entry.message.role === "assistant")) {
      throw new ConversationBranchDomainError("BRANCH_SESSION_FAILED", "Pi 分支持久化契约异常。");
    }
    try {
      writeFileSync(absNewFile, [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n",
        { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (err) {
      throw new ConversationBranchDomainError("BRANCH_SESSION_FAILED",
        `分支会话持久化失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 完整文件级验证（§7.2-4） ----
  const verifySm = SessionManager.open(absNewFile);
  const header = verifySm.getHeader();
  const expectedParent = isAbsolute(sourceSessionFile)
    ? sourceSessionFile
    : resolve(sourceSessionFile);
  const actualParent = header?.parentSession;
  if (
    !header ||
    !actualParent ||
    (isAbsolute(actualParent)
      ? actualParent !== expectedParent
      : resolve(actualParent) !== expectedParent)
  ) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      "分支会话验证失败：parentSession 未指向源会话。",
    );
  }
  const childBranch = verifySm.getBranch();
  const childIds = new Set(childBranch.map((entry) => entry.id));
  if (!childIds.has(leafEntryId)) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      "分支会话验证失败：目标 leaf 不在新会话中。",
    );
  }
  // leaf 之外的源 entries 不得复制（排除 Pi 重新生成的 label entries）
  const leaked = sourceEntriesAfterLeaf.filter(
    (entry) => entry.type !== "label" && childIds.has(entry.id),
  );
  if (leaked.length > 0) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      `分支会话验证失败：leaf 之后的 ${leaked.length} 个条目泄漏进新会话。`,
    );
  }
  try {
    verifySm.buildSessionContext();
  } catch (err) {
    throw new ConversationBranchDomainError(
      "BRANCH_SESSION_FAILED",
      `分支会话验证失败：上下文构建异常（${err instanceof Error ? err.message : String(err)}）。`,
    );
  }

  return {
    sessionFile: absNewFile,
    leafEntryId,
    persisted: true,
    inheritedLastEntryId: verifySm.getLeafId() ?? leafEntryId,
  };
}

/** Resolve workspace provenance from Pi's existing session ancestry, not a new
 * conversation tree. Used only for independent MyBuddy forks. Files remain intact. */
export function resolveConversationBranchSourceRoots(sessionFile: string | undefined, targetCwd: string): string[] {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  const visited = new Set<string>();
  const roots = new Set<string>();
  let cursor: string | undefined = sessionFile;
  for (let depth = 0; cursor && depth < 64; depth++) {
    const file = resolve(cursor);
    if (visited.has(file)) throw new Error("会话来源链存在循环，拒绝建立文件访问策略。");
    visited.add(file);
    if (!existsSync(file)) break;
    const header = SessionManager.open(file).getHeader();
    if (!header) break;
    if (depth > 0 && resolve(header.cwd) !== resolve(targetCwd)) roots.add(resolve(header.cwd));
    cursor = header.parentSession;
  }
  return [...roots];
}

/**
 * §7.4：child 的 usage 回填必须跳过继承段（继承 entry 保留原始 entry_id，
 * 与 parent 的 usage_events 全局主键冲突；且历史 usage 不应双计）。
 * 物化后立即写入 usage_backfill_state 水位，使后续 backfillSession(childFile)
 * 只统计 child 创建后新增 entry。返回 true 表示水位已就位。
 */
export function writeConversationBranchUsageWatermark(
  dbConnection: Pick<BetterSqlite3.Database, "prepare">,
  sessionFile: string,
  inheritedLastEntryId: string,
): boolean {
  if (!sessionFile || !inheritedLastEntryId) return false;
  let size = 0;
  try {
    const stat = statSync(sessionFile);
    size = stat.size;
  } catch {
    size = 0;
  }
  const row = dbConnection
    .prepare(
      `SELECT 1 AS found FROM usage_backfill_state WHERE session_file = ?`,
    )
    .get(sessionFile) as { found: number } | undefined;
  if (row) {
    dbConnection
      .prepare(
        `UPDATE usage_backfill_state
         SET last_entry_id = ?, file_size = ?, file_mtime = ?, updated_at = ?
         WHERE session_file = ?`,
      )
      .run(inheritedLastEntryId, size, 0, Date.now(), sessionFile);
    return true;
  }
  dbConnection
    .prepare(
      `INSERT INTO usage_backfill_state
         (session_file, last_entry_id, file_size, file_mtime, user_messages, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(sessionFile, inheritedLastEntryId, size, 0, Date.now());
  return true;
}
