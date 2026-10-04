/**
 * conversation-branch-test.ts — 对话分支领域测试（实施规划 §13.1/§13.2）。
 *
 * 覆盖：
 * - Phase 0 characterization：Pi createBranchedSession 源文件不变、物化路径语义
 *   （getBranch(fromId) 沿 parentId 链向上 → leaf 即分支目标最深 entry）；
 * - resolveConversationBranchLeaf：entryId 主锚点 / userMessageIndex 回退与越界 /
 *   position 一致性 / 不在 active branch / 过滤型 user 消息不错位（§7.1）；
 * - after_reply 边界：排除 marker/label/branch_summary/compaction（§7.2）；
 * - createConversationBranchSession：parentSession、leaf、无泄漏、懒写契约（§7.2）；
 * - loadTaskHistoryFromSession：entryId 透传一致 + cwd override 解析（§7.1/§7.3）；
 * - usage 水位：继承段不触发 UNIQUE 冲突、只统计 child 新增（§7.4）；
 * - AppDatabase：additive 表、v27 保留、事务、requestId 幂等、级联语义（§5/§13.2）。
 *
 * 运行：pnpm test:conversation-branch
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { UsageStatsService } from "../src/main/usage/UsageStatsService";
import {
  ConversationBranchDomainError,
  createConversationBranchSession,
  resolveConversationBranchLeaf,
  writeConversationBranchUsageWatermark,
} from "../src/main/agent/session-branch";
import { loadTaskHistoryFromSession } from "../src/main/agent/session-history";

let passed = 0;
let failed = 0;
function assertOk(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
function assertThrowsCode(
  fn: () => unknown,
  code: string,
  label: string,
): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label}（未抛错）`);
  } catch (err) {
    if (err instanceof ConversationBranchDomainError && err.code === code) {
      passed++;
      console.log(`  ✓ ${label}（${code}）`);
    } else {
      failed++;
      console.error(`  ✗ ${label}（期望 ${code}，实际 ${(err as Error).message}）`);
    }
  }
}
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function flush(code: () => void): void {
  code();
}
function fileHash(path: string): string {
  return sha256(readFileSync(path, "utf8"));
}

/* ------------------------------------------------------------------ */
/* session 构造 helper                                                  */
/* ------------------------------------------------------------------ */

interface BuiltSession {
  dir: string;
  cwd: string;
  sessionFile: string;
  entries: Array<{ id: string; type: string; role?: string }>;
  leaves: {
    u1: string; a1: string;
    u2: string; a2Tool: string; a2Result: string; a2Final: string;
    u3: string; a3: string;
  };
}

/**
 * 3 轮会话：
 *  u1 → a1（纯文本）
 *  u2 → a2：toolCall(write) → toolResult → 最终文本
 *  u3 → a3（纯文本）
 */
function buildThreeTurnSession(root: string): BuiltSession {
  const dir = join(root, "sessions");
  const cwd = join(root, "work");
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "第一问" });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "第一答" }] });
  sm.appendMessage({ role: "user", content: "第二问" });
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先写文件" },
      {
        type: "toolCall",
        id: "tc-write-1",
        name: "write",
        arguments: { path: "notes.txt", content: "hello" },
      },
    ],
  });
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "tc-write-1",
    content: [{ type: "text", text: "written" }],
  });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "第二答" }],
  });
  sm.appendMessage({ role: "user", content: "第三问" });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "第三答" }] });

  const sessionFile = sm.getSessionFile()!;
  const entries = sm
    .getBranch()
    .map((e) => ({
      id: e.id,
      type: e.type,
      role: (e as { message?: { role?: string } }).message?.role,
    }));
  const userIdx = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "message" && e.role === "user")
    .map(({ i }) => i);
  const assIdx = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "message" && e.role === "assistant")
    .map(({ i }) => i);
  const resultIdx = entries.findIndex((e) => e.type === "message" && e.role === "toolResult");
  const leaves = {
    u1: entries[userIdx[0]].id,
    u2: entries[userIdx[1]].id,
    u3: entries[userIdx[2]].id,
    a1: entries[assIdx[0]].id,
    a2Tool: entries[assIdx[1]].id,
    a2Result: resultIdx >= 0 ? entries[resultIdx].id : "",
    a2Final: entries[assIdx[2]].id,
    a3: entries[assIdx[3]].id,
  };
  return { dir, cwd, sessionFile, entries, leaves };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

let root: string;
try {
  root = mkdtempSync(join(tmpdir(), "conv-branch-test-"));
  console.log("== Phase 0：Pi createBranchedSession characterization ==");

  // ① 源文件不变 + 物化路径语义（leaf = 路径最深 entry；getBranch 沿 parentId 向上）
  const s1 = buildThreeTurnSession(root);
  const beforeHash = fileHash(s1.sessionFile);
  const open1 = SessionManager.open(s1.sessionFile, undefined, s1.cwd);
  const leafMiddleUser = s1.leaves.u2;
  const childFile1 = open1.createBranchedSession(leafMiddleUser)!;
  const child1 = SessionManager.open(childFile1);
  const child1Roles = child1
    .getBranch()
    .map((e) => (e as { message?: { role?: string } }).message?.role ?? e.type)
    .join(",");
  assertOk(
    child1Roles === "user,assistant,user",
    `① after_user 物化 = root→该 user 的路径（实际: ${child1Roles}）`,
  );
  assertOk(existsSync(childFile1), "① 中间 user 分支（路径含 assistant）立即落盘");
  assertOk(
    child1.getHeader()?.parentSession === s1.sessionFile,
    "① child header parentSession 指向源文件",
  );
  const afterHash = fileHash(s1.sessionFile);
  assertOk(beforeHash === afterHash, "① 源 session 文件 hash 不变");

  // ② Pi 0.99.2 persists a user-only branch immediately; no host materialization is needed.
  const open1b = SessionManager.open(s1.sessionFile, undefined, s1.cwd);
  const childFile1b = open1b.createBranchedSession(s1.leaves.u1)!;
  assertOk(
    childFile1b !== s1.sessionFile && existsSync(childFile1b),
    "② Pi 原生 root user 分支已持久化且路径不同于源",
  );

  const userOnlyBranch = SessionManager.open(childFile1b);
  assertOk(userOnlyBranch.getBranch().filter(entry => entry.type === "message").every(entry => entry.type === "message" && entry.message.role === "user"), "② 分支只含原生 user 路径");
  assertOk(fileHash(s1.sessionFile) === beforeHash, "② 原生分支不改写源会话");

  // ③ after_reply 物化 = 完整助手回合（含 tool call/result）
  const open1c = SessionManager.open(s1.sessionFile, undefined, s1.cwd);
  const childFile1c = open1c.createBranchedSession(s1.leaves.a2Final)!;
  const child1c = SessionManager.open(childFile1c);
  const child1cRoles = child1c
    .getBranch()
    .map((e) => (e as { message?: { role?: string } }).message?.role ?? e.type)
    .join(",");
  assertOk(
    child1cRoles === "user,assistant,user,assistant,toolResult,assistant",
    `③ after_reply 物化包含整个回合（实际: ${child1cRoles}）`,
  );

  // ④ 弃用支路：branch() 后追加新消息，active path 只取新支路
  const s2 = buildThreeTurnSession(root);
  const open2 = SessionManager.open(s2.sessionFile, undefined, s2.cwd);
  open2.branch(s2.leaves.u1);
  open2.appendMessage({ role: "assistant", content: [{ type: "text", text: "重来" }] });
  const activeRoles = open2
    .getBranch()
    .map((e) => (e as { message?: { role?: string } }).message?.role ?? e.type)
    .join(",");
  assertOk(
    activeRoles === "user,assistant",
    `④ 弃用支路后 active path 只含新支路（实际: ${activeRoles}）`,
  );
  const childFile2 = open2.createBranchedSession(open2.getLeafId()!)!;
  const child2 = SessionManager.open(childFile2);
  const child2Ids = child2.getBranch().map((e) => e.id);
  assertOk(
    !child2Ids.includes(s2.leaves.u2),
    "④ 物化只取 active branch，不含已弃用支路",
  );

  console.log("== Phase 1：resolveConversationBranchLeaf ==");

  // ⑤ 主锚点 entryId：after_user 中间用户消息
  const r1 = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    entryId: s1.leaves.u2,
    position: "after_user",
  });
  assertOk(r1.leafEntryId === s1.leaves.u2, "⑤ after_user leaf = user entry 自身");
  assertOk(r1.resolvedUserMessageIndex === 1, "⑤ 导出序号 = 1（原始序号，含全部 user）");

  // ⑥ after_reply：leaf = 区间内最后一个 message entry（a2Final，排除 toolResult 前面的 thinking）
  const r2 = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    entryId: s1.leaves.u2,
    position: "after_reply",
  });
  assertOk(
    r2.leafEntryId === s1.leaves.a2Final,
    `⑥ after_reply leaf = 回合最后 message entry（实际 ${r2.leafEntryId}）`,
  );

  // ⑥b UI 真实语义：助手消息锚点（assistant entry）→ 回溯所属回合 user 起点
  const r2b = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    entryId: s1.leaves.a2Final,
    position: "after_reply",
  });
  assertOk(
    r2b.userEntryId === s1.leaves.u2 && r2b.leafEntryId === s1.leaves.a2Final,
    "⑥b assistant 锚点回溯到所属回合 user 起点，leaf 仍为该回合最后消息",
  );
  const r2c = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    entryId: s1.leaves.a1,
    position: "after_reply",
  });
  assertOk(
    r2c.userEntryId === s1.leaves.u1 && r2c.leafEntryId === s1.leaves.a1,
    "⑥b 第一回合 assistant 锚点回溯到 u1",
  );
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
        entryId: s1.leaves.a1,
        position: "after_user",
      }),
    "POSITION_MISMATCH",
    "⑥b assistant 锚点 + after_user 拒绝",
  );

  // ⑦ 最后一条助手消息分支
  const r3 = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    entryId: s1.leaves.u3,
    position: "after_reply",
  });
  assertOk(r3.leafEntryId === s1.leaves.a3, "⑦ 最后助手消息分支 leaf = a3");

  // ⑧ userMessageIndex 主锚点缺失时回退：命中第 1 条 user（导出序 0-based）
  const r4 = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    userMessageIndex: 1,
    position: "after_user",
  });
  assertOk(r4.userEntryId === s1.leaves.u2, "⑧ userMessageIndex 回退命中第 2 条 user");
  assertOk(r4.resolvedUserMessageIndex === 1, "⑧ 回退导出序号一致");

  // ⑧b live 新消息（无 entryId）：回退 + after_reply（模拟 live 助手消息）
  const r4b = resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
    userMessageIndex: 1,
    position: "after_reply",
  });
  assertOk(
    r4b.userEntryId === s1.leaves.u2 && r4b.leafEntryId === s1.leaves.a2Final,
    "⑧b live 助手消息回退：leaf = 第 2 回合最后消息",
  );

  // ⑨ 越界/无效拒绝
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
        userMessageIndex: 99,
        position: "after_user",
      }),
    "ANCHOR_NOT_FOUND",
    "⑨ userMessageIndex 越界拒绝",
  );
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
        userMessageIndex: -1,
        position: "after_user",
      }),
    "ANCHOR_NOT_FOUND",
    "⑨ userMessageIndex 负数拒绝",
  );
  assertThrowsCode(
    () => resolveConversationBranchLeaf(join(root, "missing.jsonl"), s1.cwd, {
      userMessageIndex: 0,
      position: "after_user",
    }),
    "SESSION_MISSING",
    "⑨ 源 session 不存在拒绝",
  );

  // ⑩ 不在 active branch（旧支路 entry）拒绝
  const s3 = buildThreeTurnSession(root);
  const open3 = SessionManager.open(s3.sessionFile, undefined, s3.cwd);
  open3.branch(s3.leaves.u1);
  open3.appendMessage({ role: "assistant", content: [{ type: "text", text: "重来" }] });
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s3.sessionFile, s3.cwd, {
        entryId: s3.leaves.u2,
        position: "after_user",
      }),
    "ANCHOR_NOT_IN_ACTIVE_BRANCH",
    "⑩ 已弃用支路的 entry 拒绝",
  );
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s3.sessionFile, s3.cwd, {
        entryId: "not-an-entry",
        position: "after_user",
      }),
    "ANCHOR_NOT_FOUND",
    "⑩ 不存在的 entryId 拒绝（ANCHOR_NOT_FOUND）",
  );

  // ⑪ position 与角色一致性
  assertThrowsCode(
    () =>
      resolveConversationBranchLeaf(s1.sessionFile, s1.cwd, {
        entryId: s1.leaves.a1,
        position: "after_user",
      }),
    "POSITION_MISMATCH",
    "⑪ after_user 指向 assistant entry 拒绝",
  );

  // ⑫ 过滤型 user 消息（空 content）不导致 entryId 主锚点错位
  const s4dir = join(root, "s4");
  const s4sm = SessionManager.create(join(s4dir, "work"), join(s4dir, "sessions"));
  s4sm.appendMessage({ role: "user", content: "" }); // parseUserPrompt 会过滤（空）
  s4sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "答空" }] });
  s4sm.appendMessage({ role: "user", content: "真正的问题" });
  s4sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "真正的答复" }] });
  const s4File = s4sm.getSessionFile()!;
  const s4Branch = s4sm.getBranch();
  const s4Users = s4Branch.filter(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
  );
  // UI 过滤后只有 1 条 user 消息（序号 0），但原始 anchor 是第 2 条（entryId 精确）
  const historyS4 = loadTaskHistoryFromSession(s4File, s4sm.getCwd());
  const uiUsers = historyS4.messages.filter((m) => m.role === "user");
  assertOk(uiUsers.length === 1, `⑫ 空 user 消息被 UI 过滤（实际 ${uiUsers.length}）`);
  const r5 = resolveConversationBranchLeaf(s4File, s4sm.getCwd(), {
    entryId: s4Users[1].id,
    position: "after_reply",
  });
  assertOk(
    r5.resolvedUserMessageIndex === 0,
    "⑫ entryId 主锚点命中第二条原始 user，展示序号为 0",
  );
  assertOk(
    r5.leafEntryId === s4Branch[s4Branch.length - 1].id,
    "⑫ after_reply 锚点落在真正问题回合的最终答复",
  );
  // 回退也必须匹配 UI：序号 0 指向可见问题，不能命中被隐藏的空消息。
  const r5b = resolveConversationBranchLeaf(s4File, s4sm.getCwd(), {
    userMessageIndex: 0,
    position: "after_user",
  });
  assertOk(
    r5b.userEntryId === s4Users[1].id,
    "⑫ userMessageIndex 回退口径与过滤后的 UI 一致",
  );

  console.log("== Phase 1：createConversationBranchSession ==");

  // ⑬ 物化整体验证（parentSession/leaf/无泄漏/上下文可构建）
  const m1 = createConversationBranchSession(s1.sessionFile, s1.cwd, r2.leafEntryId);
  assertOk(m1.persisted, "⑬ 含 assistant 的物化立即落盘");
  assertOk(m1.sessionFile !== s1.sessionFile, "⑬ 新文件路径不同");
  const v1 = SessionManager.open(m1.sessionFile);
  assertOk(v1.getHeader()?.parentSession === s1.sessionFile, "⑬ parentSession 指向源");
  const v1Ids = v1.getBranch().map((e) => e.id);
  assertOk(v1Ids[v1Ids.length - 1] === r2.leafEntryId, "⑬ leaf 为新文件最后 entry");
  const sourceBranch = SessionManager.open(s1.sessionFile, undefined, s1.cwd).getBranch();
  const sourceIdSet = new Set(sourceBranch.map((e) => e.id));
  const afterLeafIds = new Set(
    sourceBranch.slice(sourceBranch.findIndex((e) => e.id === r2.leafEntryId) + 1).map((e) => e.id),
  );
  const leakedAfter = v1Ids.filter((id) => afterLeafIds.has(id));
  assertOk(leakedAfter.length === 0, `⑬ leaf 之后无源 entry 泄漏（实际 ${JSON.stringify(leakedAfter)}）`);
  const foreign = v1Ids.filter(
    (id) => !sourceIdSet.has(id) && id !== v1.getHeader()?.id && v1.getBranch().find((e) => e.id === id)?.type !== "label",
  );
  assertOk(foreign.length === 0, `⑬ 无外来 entry（实际 ${JSON.stringify(foreign)}）`);
  const ctx = v1.buildSessionContext();
  assertOk(ctx.messages.length > 0, "⑬ buildSessionContext 可执行");

  // ⑭ header cwd override：物化时传 targetCwd → 新 header cwd = target（§7.3）
  const targetCwd = join(root, "child-work");
  const m2 = createConversationBranchSession(s1.sessionFile, targetCwd, r3.leafEntryId);
  const v2Header = SessionManager.open(m2.sessionFile).getHeader();
  assertOk(
    v2Header?.cwd === targetCwd,
    `⑭ 新 header cwd = child canonical cwd（实际 ${v2Header?.cwd}）`,
  );

  // ⑮ 懒写路径：root user after_user 物化 → 服务强制落盘（§7.2 懒写契约修正）
  const m3 = createConversationBranchSession(s1.sessionFile, s1.cwd, s1.leaves.u1);
  assertOk(m3.persisted === true, "⑮ 物化强制落盘（不再依赖 first-assistant 懒写）");
  assertOk(existsSync(m3.sessionFile), "⑮ child 文件真实存在");
  assertOk(m3.inheritedLastEntryId === s1.leaves.u1, "⑮ 继承段水位 = leaf");
  const v3 = SessionManager.open(m3.sessionFile);
  const v3Header = v3.getHeader();
  const sourceHeader = SessionManager.open(s1.sessionFile, undefined, s1.cwd).getHeader();
  assertOk(v3Header?.id !== sourceHeader?.id, "⑮ user-only fallback 使用独立 Pi session id");
  assertOk(v3Header?.parentSession === s1.sessionFile, "⑮ user-only fallback parentSession 指向源");
  assertOk(v3Header?.cwd === s1.cwd, "⑮ user-only fallback cwd 由 Pi SessionManager 生成");
  assertOk(
    v3.getBranch().every((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user"),
    "⑮ 落盘内容仅含 user 路径（无多余 entry）",
  );
  // 落盘后追加：Pi flush 语义正常（追加而非整写）
  v3.appendMessage({ role: "assistant", content: [{ type: "text", text: "首次回复" }] });
  const v3b = SessionManager.open(m3.sessionFile);
  const v3bRoles = v3b
    .getBranch()
    .map((e) => (e as { message?: { role?: string } }).message?.role ?? e.type)
    .join(",");
  assertOk(v3bRoles === "user,assistant", "⑮ 强制落盘文件可继续正常追加");

  console.log("== Phase 1：usage 水位（§7.4） ==");
  flush(() => {
    const dbFile = join(root, "usage.db");
    const db = new AppDatabase(dbFile);
    const usage = new UsageStatsService(db.connection);
    // 先回填 source（写入继承段 usage）
    usage.backfillSession(s1.sessionFile);
    const m4 = createConversationBranchSession(s1.sessionFile, s1.cwd, r2.leafEntryId);
    // child 物化后写水位 → 继承段不再参与 child 回填
    writeConversationBranchUsageWatermark(
      db.connection,
      m4.sessionFile,
      m4.inheritedLastEntryId,
    );
    let threw = false;
    try {
      usage.backfillSession(m4.sessionFile);
    } catch {
      threw = true;
    }
    assertOk(!threw, "⑮ child backfill 不抛 UNIQUE constraint failed");
    const inheritedRows = db.connection
      .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE session_file = ?`)
      .get(m4.sessionFile) as { n: number };
    assertOk(
      inheritedRows.n === 0,
      `⑮ 继承段不写入 child 用量（实际 ${inheritedRows.n} 行）`,
    );
    // child 追加新消息后回填只统计新增
    const childSm = SessionManager.open(m4.sessionFile);
    childSm.appendMessage({ role: "user", content: "分支继续" });
    childSm.appendMessage({ role: "assistant", content: [{ type: "text", text: "分支答复" }] });
    usage.backfillSession(m4.sessionFile);
    const childRows = db.connection
      .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE session_file = ?`)
      .get(m4.sessionFile) as { n: number };
    assertOk(
      childRows.n === 1,
      `⑮ 只统计 child 新增的 assistant 调用（实际 ${childRows.n} 行）`,
    );
    db.close();
  });

  console.log("== Phase 1：loadTaskHistoryFromSession（entryId + cwd override，§7.1/§7.3） ==");

  // ⑯ entryId 透传与 active path 一致
  const history = loadTaskHistoryFromSession(s1.sessionFile, s1.cwd);
  const uiUserIds = history.messages.filter((m) => m.role === "user").map((m) => m.entryId);
  const piUserIds = s1.entries
    .filter((e) => e.type === "message" && e.role === "user")
    .map((e) => e.id);
  assertOk(
    JSON.stringify(uiUserIds) === JSON.stringify(piUserIds),
    `⑯ user 消息 entryId 与 Pi active path 完全一致（${JSON.stringify(uiUserIds)}）`,
  );
  const uiAssistantIds = history.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.entryId);
  const piAssistantTurns = [s1.leaves.a1, s1.leaves.a2Final, s1.leaves.a3];
  assertOk(
    JSON.stringify(uiAssistantIds) === JSON.stringify(piAssistantTurns),
    `⑯ assistant 回合 entryId = 回合最后 message entry（${JSON.stringify(uiAssistantIds)}）`,
  );

  // ⑰ cwd override：header cwd=source 而 override=target → artifact 相对路径按 target 解析
  const overrideRoot = join(root, "override-target");
  const fullTarget = join(overrideRoot, "work");
  mkdirSync(fullTarget, { recursive: true });
  writeFileSync(join(fullTarget, "notes.txt"), "override content", "utf8");
  const historyOverride = loadTaskHistoryFromSession(s1.sessionFile, fullTarget);
  assertOk(historyOverride.cwd === fullTarget, "⑰ TaskHistoryDto.cwd = override 后 cwd");
  const artifactPath = historyOverride.messages
    .flatMap((m) => m.artifacts ?? [])
    .find((a) => a.name === "notes.txt")?.path;
  assertOk(
    artifactPath === join(fullTarget, "notes.txt"),
    `⑰ artifact 相对路径按 override cwd 解析（实际 ${artifactPath}）`,
  );
  assertOk(
    existsSync(join(fullTarget, "notes.txt")),
    "⑰ override 目录真实存在（解析根为 override 而非 header cwd）",
  );

  // ⑱ 删除 marker 语义：deleteUserMessage 的 marker 后无尾巴，分支不受影响
  const s5dir = join(root, "s5");
  const s5sm = SessionManager.create(join(s5dir, "work"), join(s5dir, "sessions"));
  s5sm.appendMessage({ role: "user", content: "q1" });
  s5sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a1" }] });
  s5sm.appendMessage({ role: "user", content: "q2" });
  s5sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a2" }] });
  const s5File = s5sm.getSessionFile()!;
  const s5Branch = s5sm.getBranch();
  const s5u2 = s5Branch.find(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user" && (e as { message?: { content?: string } }).message?.content === "q2",
  )!;
  // 模拟 deleteUserMessage：branch 到 q2 的 parent，追加 marker
  const open5 = SessionManager.open(s5File, undefined, s5sm.getCwd());
  open5.branch(s5u2.parentId!);
  open5.appendCustomEntry("mybuddy_deleted_user_message", {
    deletedEntryId: s5u2.id,
    deletedAt: Date.now(),
  });
  const s5Active = open5.getBranch();
  const marker = s5Active.find((e) => e.type === "custom");
  assertOk(Boolean(marker), "⑱ deleteUserMessage marker 在 active path");
  assertOk(s5Active[s5Active.length - 1]?.type === "custom", "⑱ marker 之后无消息尾巴");
  // 从 q1 after_reply 分支：child 不含 marker 与 q2
  const r6 = resolveConversationBranchLeaf(s5File, s5sm.getCwd(), {
    entryId: s5Branch[0].id,
    position: "after_reply",
  });
  const m6 = createConversationBranchSession(s5File, s5sm.getCwd(), r6.leafEntryId);
  const v6 = SessionManager.open(m6.sessionFile);
  const v6Ids = v6.getBranch().map((e) => e.id);
  assertOk(
    !v6Ids.includes(s5u2.id) && !v6.getBranch().some((e) => e.type === "custom"),
    "⑱ child 不继承被删消息与 marker",
  );

  // ⑲ label / branch_summary：Pi 原生重建，child 上下文可构建
  // label 场景：label 追加后仍留在 active path（该路径继续追加）
  const s6 = buildThreeTurnSession(root);
  const open6 = SessionManager.open(s6.sessionFile, undefined, s6.cwd);
  open6.appendLabelChange(s6.leaves.a2Final, "里程碑");
  open6.appendMessage({ role: "user", content: "第四问" });
  open6.appendMessage({ role: "assistant", content: [{ type: "text", text: "第四答" }] });
  const s6Branch = open6.getBranch();
  assertOk(
    s6Branch.some((e) => e.type === "label"),
    "⑲ label entry 在 active path 中",
  );
  const s6u4 = s6Branch.find(
    (e) => e.type === "message" && (e as { message?: { content?: string } }).message?.content === "第四问",
  )!;
  const r7 = resolveConversationBranchLeaf(s6.sessionFile, s6.cwd, {
    entryId: s6u4.id,
    position: "after_user",
  });
  assertOk(r7.leafEntryId === s6u4.id, "⑲ 含 label 的路径定位正常");
  const m7 = createConversationBranchSession(s6.sessionFile, s6.cwd, r7.leafEntryId);
  const v7 = SessionManager.open(m7.sessionFile);
  const v7ctx = v7.buildSessionContext();
  assertOk(v7ctx.messages.length > 0, "⑲ label 重建后上下文可构建");
  const v7Labels = v7.getBranch().filter((e) => e.type === "label");
  assertOk(v7Labels.length >= 1, `⑲ label entries 在 child 中重建（实际 ${v7Labels.length}）`);
  // branch_summary 场景：branchWithSummary 后新支路分支 → child 按 Pi 原生规则含摘要
  const s7 = buildThreeTurnSession(root);
  const open7 = SessionManager.open(s7.sessionFile, undefined, s7.cwd);
  open7.branchWithSummary(s7.leaves.u1, "旧路摘要");
  open7.appendMessage({ role: "user", content: "第五问" });
  open7.appendMessage({ role: "assistant", content: [{ type: "text", text: "第五答" }] });
  const s7Branch = open7.getBranch();
  const s7u5 = s7Branch.find(
    (e) => e.type === "message" && (e as { message?: { content?: string } }).message?.content === "第五问",
  )!;
  const r8 = resolveConversationBranchLeaf(s7.sessionFile, s7.cwd, {
    entryId: s7u5.id,
    position: "after_reply",
  });
  const m8 = createConversationBranchSession(s7.sessionFile, s7.cwd, r8.leafEntryId);
  const v8 = SessionManager.open(m8.sessionFile);
  const v8Branch = v8.getBranch();
  assertOk(
    v8Branch.some((e) => e.type === "branch_summary"),
    "⑲ branch_summary 按 Pi 原生规则重建在 child 路径中",
  );
  const v8ctx = v8.buildSessionContext();
  assertOk(v8ctx.messages.length > 0, "⑲ branch_summary 场景上下文可构建");

  console.log("== Phase 1：AppDatabase 契约（§5/§13.2） ==");

  flush(() => {
    const dbFile = join(root, "branch.db");
    // 模拟现有 v27 库：先建库再补表
    const db27 = new AppDatabase(dbFile);
    db27.upsertTask({ id: "task-parent", title: "父任务", status: "completed", updatedAt: 1 });
    db27.close();

    const db = new AppDatabase(dbFile);
    assertOk(
      db.getTask("task-parent") !== undefined,
      "additive 补表后 v27 数据保留",
    );
    const tables = [
      "conversation_branches",
    ];
    for (const t of tables) {
      const row = db.connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(t);
      assertOk(Boolean(row), `additive 表 ${t} 存在`);
    }
    const requestId = randomUUID();
    const childId = "task-child-1";
    db.createConversationBranchTask({
      childTaskId: childId,
      parentTaskId: "task-parent",
      rootTaskId: "task-parent",
      parentTitleSnapshot: "父任务",
      sourceSessionFile: s1.sessionFile,
      sourceLeafEntryId: s1.leaves.a2Final,
      sourceUserMessageIndex: 1,
      requestId,
      position: "after_reply",
      workspaceStrategy: "current_snapshot",
      createdAt: 100,
      task: {
        id: childId,
        title: "父任务（分支）",
        spaceId: undefined,
        projectId: undefined,
        status: "completed",
        updatedAt: 100,
        sessionFile: s1.sessionFile,
        cwd: join(root, "child-work"),
        welcomeMode: "coding" as never,
        permissionMode: "default" as never,
        expertId: undefined,
        modePresetId: undefined,
        startAt: undefined,
        dueAt: undefined,
        spaceSortOrder: 0,
        isFavorited: false,
      },
    });
    assertOk(
      db.getTask(childId)?.title === "父任务（分支）",
      "事务插入 child task 成功",
    );
    const info = db.getConversationBranchInfo(childId);
    assertOk(info?.rootTaskId === "task-parent", "血缘 root = parent");
    assertOk(info?.parentExists === true, "parentExists=true");
    // requestId 幂等唯一
    let duplicateThrew = false;
    try {
      db.connection
        .prepare(
          `INSERT INTO conversation_branches (
             child_task_id, parent_task_id, root_task_id, parent_title_snapshot,
             source_session_file, source_leaf_entry_id, source_user_message_index,
             request_id, source_position, workspace_strategy, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "task-child-dup",
          "task-parent",
          "task-parent",
          "父任务",
          s1.sessionFile,
          s1.leaves.a1,
          0,
          requestId,
          "after_user",
          "current_snapshot",
          101,
        );
    } catch {
      duplicateThrew = true;
    }
    assertOk(duplicateThrew, "request_id 唯一约束生效");
    // 第二分支标题防重查询基础
    const children = db.listConversationBranchChildren("task-parent");
    assertOk(children.length === 1, "listConversationBranchChildren 返回直接子分支");
    // child 删除 → 级联清理 branch 行；parent 删除 → child 血缘保留
    db.deleteTask(childId);
    assertOk(db.getConversationBranchInfo(childId) === undefined, "child 删除级联清理 branch 行");
    db.upsertTask({ id: "task-child-3", title: "父任务（分支）", status: "completed", updatedAt: 102, sessionFile: s1.sessionFile, cwd: join(root, "child-work-3") });
    db.connection
      .prepare(
        `INSERT INTO conversation_branches (
           child_task_id, parent_task_id, root_task_id, parent_title_snapshot,
           source_session_file, source_leaf_entry_id, source_user_message_index,
           request_id, source_position, workspace_strategy, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "task-child-3",
        "task-parent",
        "task-parent",
        "父任务",
        s1.sessionFile,
        s1.leaves.u1,
        0,
        randomUUID(),
        "after_user",
        "conversation_only",
        102,
      );
    db.deleteTask("task-parent");
    const orphanInfo = db.getConversationBranchInfo("task-child-3");
    assertOk(orphanInfo?.parentExists === false, "parent 删除后 child 血缘保留且 parentExists=false");
    assertOk(orphanInfo?.parentTitle === "父任务", "parent 删除后标题快照保留");
    db.close();
  });

  console.log(`\nconversation-branch: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
} finally {
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Windows 上 WAL 句柄可能短暂占用；临时目录残留不影响结果
      console.warn("  (warn) 临时目录清理失败，已跳过");
    }
  }
}

void assert;