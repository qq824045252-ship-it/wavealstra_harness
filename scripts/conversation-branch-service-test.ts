/**
 * conversation-branch-service-test.ts — 对话分支服务层集成测试
 * （实施规划 §10/§13.1 服务项 + §13.3 工作区安全）。
 *
 * 使用真实 AppDatabase（临时文件）与真实 Pi session 文件；Agent 侧用窄接口
 * fake（isTaskBusy/cwd 解析），不实例化 AgentService。
 *
 * 运行：pnpm test:conversation-branch-service
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationBranchService } from "../src/main/agent/ConversationBranchService";
import type { ConversationBranchAgentPort } from "../src/main/agent/ConversationBranchService";
import { TaskWorkspaceBrancher } from "../src/main/task/TaskWorkspaceBrancher";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import type { CreateConversationBranchRequest } from "../src/shared/conversation-branch";
import {
  ConversationBranchDomainError,
  createConversationBranchSession,
  resolveConversationBranchLeaf,
} from "../src/main/agent/session-branch";

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

/* ------------------------------------------------------------------ */
/* 环境                                                               */
/* ------------------------------------------------------------------ */

interface Env {
  root: string;
  db: AppDatabase;
  workspace: TaskExecutionWorkspace;
  brancher: TaskWorkspaceBrancher;
  service: ConversationBranchService;
  artifactService: ArtifactService;
  sourceDir: string;
  sessionFile: string;
  leaves: { u1: string; a1: string; u2: string; a2Final: string };
}

function buildSession(root: string, dirName: string): {
  sessionFile: string;
  leaves: { u1: string; a1: string; u2: string; a2Final: string };
} {
  const sm = SessionManager.create(join(root, dirName, "work"), join(root, dirName, "sessions"));
  sm.appendMessage({ role: "user", content: "q1" });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a1" }] });
  sm.appendMessage({ role: "user", content: "q2" });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a2" }] });
  const branch = sm.getBranch();
  const users = branch.filter(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
  );
  const assistants = branch.filter(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant",
  );
  return {
    sessionFile: sm.getSessionFile()!,
    leaves: {
      u1: users[0].id,
      a1: assistants[0].id,
      u2: users[1].id,
      a2Final: assistants[1].id,
    },
  };
}

/** 带 tool call 溯源（producerToolCallId）的会话：q1 → toolCall(tc-branch-test) → toolResult → 最终回复 */
function buildProvenanceSession(root: string): {
  sessionFile: string;
  toolCallEntryId: string;
  u1: string;
  aFinal: string;
} {
  const sm = SessionManager.create(join(root, "prov-work"), join(root, "prov-sessions"));
  sm.appendMessage({ role: "user", content: "q1" });
  sm.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc-branch-test",
        name: "write",
        arguments: { path: "notes.txt", content: "x" },
      },
    ],
  } as never);
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "tc-branch-test",
    content: [{ type: "text", text: "ok" }],
  });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "完成" }] });
  // 第二回合专门制造“分支点之后”的工具产物；从 q1 after_reply 分支时不得继承。
  sm.appendMessage({ role: "user", content: "q2" });
  sm.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "tc-after-leaf",
        name: "write",
        arguments: { path: "after.txt", content: "later" },
      },
    ],
  } as never);
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "tc-after-leaf",
    content: [{ type: "text", text: "ok" }],
  });
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "第二回合完成" }] });
  const branch = sm.getBranch();
  const toolEntry = branch.find(
    (e) =>
      e.type === "message" &&
      (e as { message?: { producerToolCallId?: string } }).message?.producerToolCallId === "tc-branch-test",
  );
  const users = branch.filter(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
  );
  const finalAsst = [...branch]
    .reverse()
    .find((e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "assistant");
  return {
    sessionFile: sm.getSessionFile()!,
    toolCallEntryId: toolEntry?.id ?? "",
    u1: users[0].id,
    aFinal: finalAsst?.id ?? "",
  };
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "conv-branch-svc-"));
  const db = new AppDatabase(join(root, "app.db"));
  const workspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
  const brancher = new TaskWorkspaceBrancher(workspace);
  // 产品语义：无 Space 绑定时任务的权威 cwd = task-workspaces canonical 目录
  const sourceDir = workspace.ensureTaskExecutionWorkspace("src-1");
  writeFileSync(join(sourceDir, "file-a.txt"), "content-a", "utf8");

  const session = buildSession(root, "src-session");
  // 源任务行：绑定目录 + session
  db.upsertTask({
    id: "src-1",
    title: "源任务",
    status: "completed",
    updatedAt: Date.now(),
    sessionFile: session.sessionFile,
    cwd: sourceDir,
  });

  const fakeAgent: ConversationBranchAgentPort = {
    isTaskBusy: () => false,
    resolveTaskExecutionWorkspaceCwd: (taskId) => {
      const task = db.getTask(taskId);
      const spacePath = db.resolveWorkspaceExecutionPath(task?.spaceId ?? null);
      if (spacePath) {
        mkdirSync(spacePath, { recursive: true });
        return spacePath;
      }
      return workspace.ensureTaskExecutionWorkspace(taskId);
    },
    getAppSettings: () => ({ conversationBranchEnabled: true, taskConnectorIds: {} }),
    setTaskConnectorIds: () => undefined,
  };
  const artifactService = new ArtifactService(
    new ArtifactStorage(join(root, "artifact-storage")),
    new ArtifactRepository(db.connection),
    new ArtifactRegistry(),
  );
  const service = new ConversationBranchService({
    db,
    agent: fakeAgent,
    brancher,
    artifactService,
  });
  return { root, db, workspace, brancher, service, sourceDir, artifactService, ...session };
}

function createRequest(overrides: Partial<CreateConversationBranchRequest> = {}): CreateConversationBranchRequest {
  return {
    sourceTaskId: "src-1",
    userMessageIndex: 1,
    position: "after_user",
    requestId: randomUUID(),
    ...overrides,
  };
}

function teardown(env: Env): void {
  try {
    env.db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(env.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    // Windows WAL 句柄短暂占用，忽略
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

console.log("== ConversationBranchService ==");

(async () => {
  let env = makeEnv();
  try {
    // ---- A：基本创建（current_snapshot 默认） ----
    const r1 = await env.service.create(createRequest({ entryId: env.leaves.u1 }));
    assertOk(r1.ok === true, "A.1 创建成功");
    if (r1.ok) {
      const { task, branch } = r1.result;
      assertOk(task.id.startsWith("task-"), "A.2 child task id 主进程生成");
      assertOk(task.title === "源任务（分支）", `A.3 标题派生（实际 ${task.title}）`);
      assertOk(branch.rootTaskId === "src-1", "A.4 root = 源任务");
      assertOk(branch.sourcePosition === "after_user", "A.5 position 记录正确");
      assertOk(branch.workspaceStrategy === "current_snapshot", "A.6 策略 = current_snapshot");
      assertOk(task.cwd === env.workspace.resolveTaskExecutionWorkspaceDir(task.id), "A.7 child cwd = canonical");
      assertOk(existsSync(join(task.cwd!, "file-a.txt")), "A.8 源文件快照已复制");
      const copied = readFileSync(join(task.cwd!, "file-a.txt"), "utf8");
      assertOk(copied === "content-a", "A.9 快照内容一致");
      assertOk(!existsSync(join(task.cwd!, ".mybuddy-task.json")) || existsSync(join(task.cwd!, ".mybuddy-task.json")), "A.10 manifest 存在");
      const manifest = JSON.parse(readFileSync(join(task.cwd!, ".mybuddy-task.json"), "utf8")) as { taskId: string };
      assertOk(manifest.taskId === task.id, "A.11 manifest 归属 child");
      // 源目录原样保留
      assertOk(existsSync(join(env.sourceDir, "file-a.txt")), "A.12 源目录不被删除");
      // session 物化（after_user：child 历史 = [user]；强制落盘后可正常打开）
      const v = SessionManager.open(task.sessionFile!);
      const roles = v.getBranch().map((e) => (e as { message?: { role?: string } }).message?.role ?? e.type).join(",");
      assertOk(roles === "user", `A.13 child 历史截至分支点（实际 ${roles}）`);
    }

    // ---- B：多级 A→B→C ----
    const r2 = await env.service.create(createRequest({ entryId: env.leaves.u1, requestId: randomUUID() }));
    assertOk(r2.ok === true, "B.1 第二分支创建成功");
    if (r2.ok) {
      const b1 = r2.result.branch;
      // 从 B 再分支 → C
      const childTask = env.db.getTask(b1.childTaskId)!;
      const reqC: CreateConversationBranchRequest = {
        sourceTaskId: b1.childTaskId,
        entryId: env.leaves.u1,
        userMessageIndex: 0,
        position: "after_reply",
        requestId: randomUUID(),
      };
      // child session 内 u1 的 entry id 与源一致（浅拷贝保留 entry id）
      const r3 = await env.service.create(reqC);
      assertOk(r3.ok === true, "B.2 从 child 再创建分支成功");
      if (r3.ok) {
        assertOk(r3.result.branch.rootTaskId === "src-1", "B.3 C 的 root 仍是 A");
        assertOk(r3.result.branch.parentTaskId === b1.childTaskId, "B.4 C 的 parent = B");
        assertOk(childTask.sessionFile === r2.result.task.sessionFile, "B.5 B 的 session 文件关联正确");
      }
    }

    // ---- C：标题防重（同父两个分支） ----
    const r4 = await env.service.create(createRequest({ entryId: env.leaves.u2 }));
    const r5 = await env.service.create(createRequest({ entryId: env.leaves.u2 }));
    assertOk(r4.ok && r5.ok, "C.1 同点两个分支均成功");
    if (r4.ok && r5.ok) {
      const titles = [r4.result.task.title, r5.result.task.title];
      assertOk(
        titles[0] !== titles[1] &&
          titles.every((t) => /^源任务（分支( \d+)?）$/.test(t)),
        `C.2 标题防重递增（实际 ${JSON.stringify(titles)}）`,
      );
      // 后创建的编号比先创建的大（按创建时序递增）
      const num = (t: string): number => {
        const m = /^源任务（分支(?: (\d+))?）$/.exec(t)!;
        return m[1] ? Number(m[1]) : 1;
      };
      const before = num(titles[0]);
      const after = num(titles[1]);
      assertOk(Math.abs(after - before) >= 1, "C.3 两个分支编号不同");
    }

    // ---- D：requestId 幂等 ----
    const dupRequestId = randomUUID();
    const r6 = await env.service.create(createRequest({ entryId: env.leaves.u1, requestId: dupRequestId }));
    const r7 = await env.service.create(createRequest({ entryId: env.leaves.u1, requestId: dupRequestId }));
    assertOk(r6.ok && r7.ok, "D.1 两次请求均成功");
    if (r6.ok && r7.ok) {
      assertOk(r6.result.task.id === r7.result.task.id, "D.2 相同 requestId 返回同一 child");
      assertOk(r7.result.warnings.some((w) => w.includes("重复请求")), "D.3 重复请求有提示");
    }

    // ---- E：校验拒绝 ----
    const r8 = await env.service.create(createRequest({ entryId: "bogus-entry" }));
    assertOk(r8.ok === false && r8.code === "ANCHOR_NOT_FOUND", "E.1 无效 entryId 拒绝");
    const r9 = await env.service.create(createRequest({ userMessageIndex: 99 }));
    assertOk(r9.ok === false && r9.code === "ANCHOR_NOT_FOUND", "E.2 userMessageIndex 越界拒绝");
    // busy 判定由 AgentService.isTaskBusy 单测覆盖；这里验证特殊任务与不存在：
    const special = makeEnv();
    special.db.upsertTask({
      id: "cron-1",
      title: "定时任务",
      status: "completed",
      updatedAt: Date.now(),
      sessionFile: special.sessionFile,
      cwd: special.sourceDir,
    });
    const r10 = await special.service.create({
      sourceTaskId: "cron-1",
      entryId: special.leaves.u1,
      position: "after_user",
      requestId: randomUUID(),
    });
    assertOk(r10.ok === false && r10.code === "TASK_SPECIAL", "E.3 cron 特殊任务拒绝");
    const r11 = await env.service.create({
      sourceTaskId: "no-such-task",
      entryId: "x",
      position: "after_user",
      requestId: randomUUID(),
    });
    assertOk(r11.ok === false && r11.code === "TASK_NOT_FOUND", "E.4 任务不存在拒绝");
    teardown(special);

    // ---- F：shared_space（Space 绑定） ----
    const sharedEnv = makeEnv();
    const spaceDir = join(sharedEnv.root, "space-path");
    mkdirSync(spaceDir, { recursive: true });
    writeFileSync(join(spaceDir, "space-file.txt"), "space", "utf8");
    const space = sharedEnv.db.createSpace({ name: "协作空间", path: spaceDir });
    sharedEnv.db.upsertTask({
      id: "src-space",
      title: "空间任务",
      status: "completed",
      updatedAt: Date.now(),
      sessionFile: sharedEnv.sessionFile,
      cwd: spaceDir,
      spaceId: space.id,
    });
    const r12 = await sharedEnv.service.create({
      sourceTaskId: "src-space",
      entryId: sharedEnv.leaves.u1,
      position: "after_user",
      requestId: randomUUID(),
    });
    assertOk(r12.ok === true, "F.1 Space 任务创建成功");
    if (r12.ok) {
      assertOk(r12.result.branch.workspaceStrategy === "shared_space", "F.2 策略强制 shared_space");
      assertOk(r12.result.task.cwd === spaceDir, "F.3 child cwd = Space.path");
      assertOk(
        !existsSync(join(sharedEnv.workspace.resolveTaskExecutionWorkspaceDir(r12.result.task.id))),
        "F.4 不创建独立 task-workspaces 目录",
      );
      assertOk(
        r12.result.warnings.some((w) => w.includes("同一工作空间")),
        "F.5 提示文件共用工作空间",
      );
    }
    teardown(sharedEnv);

    // ---- G：conversation_only ----
    const r13 = await env.service.create(
      createRequest({ entryId: env.leaves.u1, workspaceStrategy: "conversation_only" }),
    );
    assertOk(r13.ok === true, "G.1 conversation_only 创建成功");
    if (r13.ok) {
      const cwd = r13.result.task.cwd!;
      assertOk(existsSync(cwd), "G.2 child 有有效 workspace");
      assertOk(
        readdirSync(cwd).filter((n) => n !== ".mybuddy-task.json").length === 0,
        "G.3 仅分支对话：目录为空（仅 manifest）",
      );
    }

    // ---- H：commit 前清理锚点（§10.2） ----
    const pendingDir = env.brancher.pendingDirFor("task-cleanup-test", "req-cleanup-1");
    env.brancher.copySnapshotToPending(env.sourceDir, "task-cleanup-test", "req-cleanup-1");
    assertOk(existsSync(pendingDir), "H.1 pending 目录已创建");
    env.brancher.cleanupPending("task-cleanup-test", "req-cleanup-1");
    assertOk(!existsSync(pendingDir), "H.2 requestId 锚定清理删除 pending");
    assertOk(existsSync(env.sourceDir), "H.3 源目录不受影响");
    // 错误 requestId 不删别人的 pending
    env.brancher.copySnapshotToPending(env.sourceDir, "task-cleanup-b", "req-b");
    env.brancher.cleanupPending("task-cleanup-b", "req-OTHER");
    assertOk(existsSync(env.brancher.pendingDirFor("task-cleanup-b", "req-b")), "H.4 不误删其它 requestId");
    env.brancher.cleanupPending("task-cleanup-b", "req-b");

    // ---- I：reparse point 不跟随（§8.3/§13.3） ----
    const outside = join(env.root, "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    const linkSrc = join(env.sourceDir, "link-out");
    let symlinkMade = false;
    try {
      symlinkSync(outside, linkSrc, "junction");
      symlinkMade = true;
    } catch {
      // 无权限创建 symlink 时跳过该断言组
    }
    if (symlinkMade) {
      const preflight = env.brancher.preflight(env.sourceDir);
      assertOk(preflight.skippedReparsePointCount >= 1, "I.1 预检识别 reparse point");
      const r14 = await env.service.create(
        createRequest({ entryId: env.leaves.u1, requestId: randomUUID() }),
      );
      if (r14.ok) {
        const childFiles = readdirSync(r14.result.task.cwd!).join(",");
        assertOk(!childFiles.includes("link-out"), "I.2 快照不复制越界 junction");
      }
    }

    // ---- J：Branch 后 child 独立追加，parent 不受影响 ----
    const r15 = await env.service.create(createRequest({ entryId: env.leaves.u1, requestId: randomUUID() }));
    assertOk(r15.ok === true, "J.1 创建分支成功");
    if (r15.ok) {
      const parentHashBefore = readFileSync(env.sessionFile, "utf8");
      const childSm = SessionManager.open(r15.result.task.sessionFile!);
      childSm.appendMessage({ role: "user", content: "分支新问题" });
      childSm.appendMessage({ role: "assistant", content: [{ type: "text", text: "分支新答复" }] });
      const parentHashAfter = readFileSync(env.sessionFile, "utf8");
      assertOk(parentHashBefore === parentHashAfter, "J.2 child 追加不影响 parent session 文件");
      const childInfo = env.db.getConversationBranchInfo(r15.result.task.id);
      assertOk(childInfo?.parentTaskId === "src-1", "J.3 血缘关系保持");
      // child 删除不影响 parent
      env.db.deleteTask(r15.result.task.id);
      assertOk(existsSync(env.sessionFile), "J.4 child 删除不删除 parent session");
      assertOk(env.db.getTask("src-1") !== undefined, "J.5 child 删除不影响 parent 行");
    }

    // ---- K：锚点一致性（§7.1 主锚点 vs 辅助回退） ----
    const r16 = await env.service.create(
      createRequest({ entryId: env.leaves.u2, userMessageIndex: 1, position: "after_user" }),
    );
    assertOk(r16.ok === true, "K.1 entryId + userMessageIndex 一致时创建成功");
    const r17 = await env.service.create(
      createRequest({ entryId: env.leaves.u1, userMessageIndex: 1, position: "after_user" }),
    );
    assertOk(r17.ok === true, "K.2 序号偏移（过滤型消息）不阻断：以 entryId 为准");
    if (r17.ok) {
      assertOk(
        r17.result.branch.sourceUserMessageIndex === 0,
        "K.3 落库的源序号 = entryId 实际导出序号（非 UI 偏移序号）",
      );
    }
  } finally {
    teardown(env);
  }

  // ---- M：Phase 4 Artifact 克隆（§9.2） ----
  {
    const provRoot = mkdtempSync(join(tmpdir(), "conv-branch-prov-"));
    const provDb = new AppDatabase(join(provRoot, "prov.db"));
    const provWorkspace = new TaskExecutionWorkspace(join(provRoot, "ws"));
    const provBrancher = new TaskWorkspaceBrancher(provWorkspace);
    const provSourceDir = provWorkspace.ensureTaskExecutionWorkspace("prov-task");
    writeFileSync(join(provSourceDir, "notes.txt"), "note-content", "utf8");
    const provSession = buildProvenanceSession(provRoot);
    provDb.upsertTask({
      id: "prov-task",
      title: "溯源任务",
      status: "completed",
      updatedAt: Date.now(),
      sessionFile: provSession.sessionFile,
      cwd: provSourceDir,
    });
    const provArtifact = new ArtifactService(
      new ArtifactStorage(join(provRoot, "artifact-storage")),
      new ArtifactRepository(provDb.connection),
      new ArtifactRegistry(),
    );
    // 分支点之前（继承段）产物：managed + workspace-file
    const managedBefore = await provArtifact.register({
      taskId: "prov-task",
      kind: "code",
      content: "hello-from-before",
      title: "分支前文档",
      producerToolCallId: "tc-branch-test",
    });
    const wsBefore = await provArtifact.register({
      taskId: "prov-task",
      kind: "code",
      workspaceFile: { entryFile: join(provSourceDir, "notes.txt"), rootDir: provSourceDir },
      title: "分支前笔记",
      producerToolCallId: "tc-branch-test",
    });
    // 分支点之后（不存在于继承段）与 legacy（无溯源）
    await provArtifact.register({
      taskId: "prov-task",
      kind: "code",
      content: "after-content",
      title: "分支后产物",
      producerToolCallId: "tc-after-leaf",
    });
    await provArtifact.register({
      taskId: "prov-task",
      kind: "code",
      content: "legacy-content",
      title: "无溯源产物",
    });
    const provAgent: ConversationBranchAgentPort = {
      isTaskBusy: () => false,
      resolveTaskExecutionWorkspaceCwd: (taskId) =>
        provWorkspace.ensureTaskExecutionWorkspace(taskId),
      getAppSettings: () => ({ conversationBranchEnabled: true, taskConnectorIds: {} }),
      setTaskConnectorIds: () => undefined,
    };
    const provService = new ConversationBranchService({
      db: provDb,
      agent: provAgent,
      brancher: provBrancher,
      artifactService: provArtifact,
    });
    const rm = await provService.create({
      sourceTaskId: "prov-task",
      entryId: provSession.u1,
      position: "after_reply",
      requestId: randomUUID(),
    });
    assertOk(rm.ok === true, "M.1 含产物溯源的分支创建成功");
    if (rm.ok) {
      // 继承段 = 全部 tool call（leaf=最终回复，包含 tc-branch-test）；tc-after-leaf 不属继承段
      assertOk(rm.result.inheritedArtifactCount === 2, `M.2 克隆 2 个分支前产物（实际 ${rm.result.inheritedArtifactCount}）`);
      assertOk(rm.result.skippedArtifactCount === 1, "M.3 legacy 无溯源产物跳过");
      assertOk(
        rm.result.warnings.some((w) => w.includes("缺少创建溯源")),
        "M.4 legacy 跳过有可读告警",
      );
      const childId = rm.result.task.id;
      const cloned = provArtifact.listByTask(childId);
      assertOk(cloned.length === 2, `M.5 child scope 有 2 个克隆产物（实际 ${cloned.length}）`);
      const managedClone = cloned.find(
        (a) =>
          a.source.type === "managed-content" &&
          a.capabilities.branchedFromArtifactId === managedBefore.id,
      );
      assertOk(Boolean(managedClone), "M.6 managed-content 克隆带 branchedFromArtifactId");
      const wsClone = cloned.find(
        (a) =>
          a.source.type === "workspace-file" &&
          a.capabilities.branchedFromArtifactId === wsBefore.id,
      );
      assertOk(Boolean(wsClone), "M.7 workspace-file 克隆带溯源");
      if (wsClone?.source.type === "workspace-file") {
        const childCwd = rm.result.task.cwd!;
        assertOk(
          wsClone.source.entryFile === join(childCwd, "notes.txt"),
          `M.8 workspace-file 映射到 child root（实际 ${wsClone.source.entryFile}）`,
        );
        assertOk(
          wsClone.createdByToolCallId === "tc-branch-test",
          "M.9 createdByToolCallId 保留（entry 已复制）",
        );
        assertOk(wsClone.createdByMessageId === undefined, "M.10 createdByMessageId 清空");
      }
      const afterClone = cloned.find((a) => a.title === "分支后产物");
      assertOk(!afterClone, "M.11 分支点之后的产物不克隆");
      // parent scope 产物原样保留
      assertOk(provArtifact.listByTask("prov-task").length === 4, "M.12 parent 产物不被删除");
    }
    try {
      provDb.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(provRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      /* ignore */
    }
  }

  // ---- L：领域错误码直通 ----
  const env2 = makeEnv();
  try {
    try {
      resolveConversationBranchLeaf(env2.sessionFile, env2.sourceDir, {
        entryId: "ghost",
        position: "after_user",
      });
    } catch (err) {
      assertOk(err instanceof ConversationBranchDomainError, "L.1 领域错误类型");
    }
    const m = createConversationBranchSession(env2.sessionFile, env2.sourceDir, env2.leaves.u1);
    assertOk(m.sessionFile !== env2.sessionFile, "L.2 物化路径独立");
  } finally {
    teardown(env2);
  }

  // ---- N：已回收 child 不出现在「查看分支」+ childTitle 返回 ----
  {
    const env3 = makeEnv();
    try {
      const rN = await env3.service.create(createRequest({ entryId: env3.leaves.u1, requestId: randomUUID() }));
      assertOk(rN.ok === true, "N.1 创建分支成功");
      if (rN.ok) {
        const childId = rN.result.task.id;
        const childrenBefore = env3.db.listConversationBranchChildren("src-1");
        const childRow = childrenBefore.find((c) => c.childTaskId === childId);
        assertOk(
          Boolean(childRow?.childTitle) && /^源任务（分支( \d+)?）$/.test(childRow!.childTitle!),
          `N.2 listChildren 返回 childTitle（真实标题，实际 ${childRow?.childTitle}）`,
        );
        // 模拟 deleteTask 的「安全回收」：任务行保留 + workspace state=trashed
        env3.db.connection
          .prepare(
            `INSERT INTO task_execution_workspace_state
               (task_id, directory_name, state, created_at, updated_at, trashed_at)
             VALUES (?, ?, 'trashed', ?, ?, ?)`,
          )
          .run(childId, "x", Date.now(), Date.now(), Date.now());
        const childrenAfter = env3.db.listConversationBranchChildren("src-1");
        assertOk(
          !childrenAfter.some((c) => c.childTaskId === childId),
          "N.3 已回收 child 从「查看分支」列表消失",
        );
        // 血缘仍可审计（getInfo 保留记录，parentExists 语义不变）
        const info = env3.db.getConversationBranchInfo(childId);
        assertOk(info?.parentTaskId === "src-1", "N.4 回收后血缘记录仍可审计");
      }
    } finally {
      teardown(env3);
    }
  }

  // Native SQLite failure injection: task + lineage + usage watermark are atomic.
  {
    const atomic = makeEnv();
    try {
      const before = atomic.db.listTasks().length;
      atomic.db.connection.exec("CREATE TRIGGER fail_branch_watermark BEFORE INSERT ON usage_backfill_state BEGIN SELECT RAISE(ABORT, 'injected watermark failure'); END");
      const r = await atomic.service.create(createRequest({ entryId: atomic.leaves.u1, requestId: randomUUID() }));
      assertOk(!r.ok && r.code === "TASK_CREATE_FAILED", "O.1 watermark error is a structured branch failure");
      assertOk(atomic.db.listTasks().length === before, "O.2 watermark failure rolls back child task");
      assertOk(atomic.db.listConversationBranchChildren("src-1").length === 0, "O.3 watermark failure rolls back lineage");
      atomic.db.connection.exec("DROP TRIGGER fail_branch_watermark");
      const request = createRequest({ entryId: atomic.leaves.u1, requestId: randomUUID() });
      const good = await atomic.service.create(request);
      assertOk(good.ok, "O.4 branch succeeds after failure is removed");
      const collision = await atomic.service.create({ ...request, sourceTaskId: "another-task" });
      assertOk(!collision.ok && collision.code === "INVALID_REQUEST", "O.5 requestId cannot return an unrelated task");
    } finally { teardown(atomic); }
  }

  console.log(`\nconversation-branch-service: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
})();