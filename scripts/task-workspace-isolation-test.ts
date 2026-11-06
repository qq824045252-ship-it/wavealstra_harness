/**
 * TaskExecutionWorkspace 单元测试（P0 阶段 1 / 提交 1）
 *
 * 覆盖《P0-task-project-isolation-fix.md》：
 *  - §12.2 目录映射单元测试全部 11 项
 *  - §4.4 词法边界（relative 非 startsWith；win32 大小写）
 *  - §4.5 realpath/Junction 逃逸（无权限创建 Junction 时标记 SKIP，不伪造通过）
 *  - §4.6 manifest 原子写、重启后校验、taskId 不匹配报错
 *  - 测试注入（构造参数 + setTaskExecutionWorkspacesRootForTests）
 *
 * 全部数据写入 mkdtemp 临时目录；不触碰真实 ~/.mybuddy/task-workspaces 与 app.db。
 * 运行：pnpm run test:task-project-isolation
 */
import assert from "node:assert/strict";
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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  assertPathInsideTask,
  assertTaskExecutionWorkspaceDir,
  ensureTaskExecutionWorkspace,
  getTaskExecutionWorkspacesRoot,
  getTaskDirectoryName,
  isPathInsideOrEqual,
  MANIFEST_FILENAME,
  MANIFEST_TMP_SUFFIX,
  resolveTaskExecutionWorkspaceDir,
  setTaskExecutionWorkspacesRootForTests,
  TaskManifestError,
  TaskManifestMismatchError,
  TaskPathBoundaryError,
  TaskExecutionWorkspaceError,
  TaskExecutionWorkspace,
  type TaskExecutionWorkspaceManifest,
} from "../src/main/task/TaskExecutionWorkspace";
import { getTaskExecutionWorkspacesDir } from "../src/main/paths";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactRefreshCoordinator } from "../src/main/artifact/ArtifactRefreshCoordinator";
import {
  copyExternalIntoWorkspace,
  createWorkspacePath,
  diffWorkspaceSnapshot,
  isGeneratedWorkspacePath,
  listWorkspaceFiles,
  MAX_TURN_WORKSPACE_CHANGES,
  moveWorkspacePath,
  renameWorkspacePath,
  snapshotWorkspace,
} from "../src/main/workspace/WorkspaceService";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/* ---------------- 测试骨架 ---------------- */

const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-task-isolation-"));
const workspacesRoot = join(tempRoot, "task-workspaces");
mkdirSync(workspacesRoot, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}
function skip(name: string, reason: string): void {
  results.push({ name, ok: true, detail: `SKIP: ${reason}` });
  console.log(`SKIP  ${name}  (${reason})`);
}

/* ================================================================= */
/* §12.2 目录映射单元测试                                              */
/* ================================================================= */

check("1. 同一 taskId 两次解析结果相同", () => {
  assert.equal(getTaskDirectoryName("task-A"), getTaskDirectoryName("task-A"));
  const w = new TaskExecutionWorkspace(workspacesRoot);
  assert.equal(w.resolveTaskExecutionWorkspaceDir("task-A"), w.resolveTaskExecutionWorkspaceDir("task-A"));
});

check("2. 不同 taskId 结果不同", () => {
  assert.notEqual(getTaskDirectoryName("task-A"), getTaskDirectoryName("task-B"));
  const w = new TaskExecutionWorkspace(workspacesRoot);
  assert.notEqual(w.resolveTaskExecutionWorkspaceDir("task-A"), w.resolveTaskExecutionWorkspaceDir("task-B"));
});

check("3. TaskA 与 taska 在 Windows 上结果不同", () => {
  const n1 = getTaskDirectoryName("TaskA");
  const n2 = getTaskDirectoryName("taska");
  assert.notEqual(n1, n2, "大小写变体必须映射到不同目录名（哈希段不同则物理目录不冲突）");
});

check("4. a/b 与 a:b 不碰撞", () => {
  const n1 = getTaskDirectoryName("a/b");
  const n2 = getTaskDirectoryName("a:b");
  assert.notEqual(n1, n2, "非法字符替换后同前缀，哈希必须区分");
  assert.ok(n1.startsWith("a-b--"), n1);
  assert.ok(n2.startsWith("a-b--"), n2);
  assert.notEqual(n1.slice(n1.indexOf("--")), n2.slice(n2.indexOf("--")), "哈希段不同");
});

check("5. 空 taskId 拒绝", () => {
  assert.throws(() => getTaskDirectoryName(""), TaskExecutionWorkspaceError);
  assert.throws(() => getTaskDirectoryName("   "), TaskExecutionWorkspaceError);
  const w = new TaskExecutionWorkspace(workspacesRoot);
  assert.throws(() => w.resolveTaskExecutionWorkspaceDir(""), TaskExecutionWorkspaceError);
  assert.throws(() => w.ensureTaskExecutionWorkspace("  "), TaskExecutionWorkspaceError);
});

check("6. 超长 taskId 生成合法且长度受控目录名", () => {
  const longA = "L".repeat(5000) + "AAA";
  const longB = "L".repeat(5000) + "BBB";
  const nameA = getTaskDirectoryName(longA);
  const nameB = getTaskDirectoryName(longB);
  assert.ok(nameA.length <= 48 + 2 + 16, `名称长度受控: ${nameA.length}`);
  assert.equal(nameA.length, nameB.length);
  assert.notEqual(nameA, nameB, "仅尾部不同也必须得到不同目录名");
  assert.ok(!nameA.includes("/") && !nameA.includes("\\"), "目录名不得含路径分隔符");
  assert.equal(basename(nameA), nameA);
});

check("7. 中文 taskId 可用", () => {
  const id = "任务-α-测试·中文";
  const name = getTaskDirectoryName(id);
  assert.ok(name.includes("任务-α-测试·中文"), name);
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dir = w.ensureTaskExecutionWorkspace(id);
  assert.ok(existsSync(join(dir, MANIFEST_FILENAME)), "目录应创建成功且含清单");
});

check("8. CON/NUL/COM1 等不生成 Windows 保留目录名", () => {
  const cases = ["CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9", "con.txt", "COM1."];
  for (const c of cases) {
    const name = getTaskDirectoryName(c);
    assert.ok(name.startsWith("task-"), `${c} -> ${name} 应加 task- 前缀`);
    assert.ok(!WINDOWS_RESERVED.test(name.split(".")[0]), `${name} 基础名不得为保留名`);
    const dir = join(workspacesRoot, name);
    mkdirSync(dir, { recursive: true });
    assert.ok(existsSync(dir), `${dir} 应可创建`);
    rmSync(dir, { recursive: true, force: true });
  }
});

check("9. ..、绝对路径、盘符、UNC 字符串都不能逃出 workspaces root", () => {
  const malicious = [
    "..",
    "...",
    "../..",
    "..\\..",
    "C:\\Windows\\System32",
    "C:/Windows",
    "\\\\server\\share\\x",
    "a///b",
    "a\\\\b",
  ];
  const w = new TaskExecutionWorkspace(workspacesRoot);
  for (const m of malicious) {
    const name = getTaskDirectoryName(m);
    const dir = w.resolveTaskExecutionWorkspaceDir(m);
    assert.ok(isPathInsideOrEqual(workspacesRoot, dir), `${m} -> ${dir} 必须位于 workspaces root 内`);
    assert.ok(!name.includes("/") && !name.includes("\\"), `${m} 目录名不得含分隔符: ${name}`);
    assert.ok(name !== "." && name !== "..", `${m} 目录名不得为 . 或 ..`);
  }
});

check("10. manifest 重启后可校验（模拟重启：新实例同一 root）", () => {
  const w1 = new TaskExecutionWorkspace(workspacesRoot);
  const dir1 = w1.ensureTaskExecutionWorkspace("persist-task");
  const m1 = JSON.parse(readFileSync(join(dir1, MANIFEST_FILENAME), "utf8")) as TaskExecutionWorkspaceManifest;
  assert.equal(m1.version, 1);
  assert.equal(m1.taskId, "persist-task");
  assert.equal(typeof m1.createdAt, "number");

  // 模拟重启：用新的 workspace 实例重新解析同一 workspaces root
  const w2 = new TaskExecutionWorkspace(workspacesRoot);
  const dir2 = w2.ensureTaskExecutionWorkspace("persist-task");
  assert.equal(dir2, dir1, "重启后目录不变");
  const m2 = JSON.parse(readFileSync(join(dir2, MANIFEST_FILENAME), "utf8")) as TaskExecutionWorkspaceManifest;
  assert.deepEqual(m2, m1, "重启后清单内容不变（createdAt 稳定）");
  assert.deepEqual(readdirSync(dir1), [MANIFEST_FILENAME], "目录内无残留临时文件");
});

check("11. manifest taskId 不匹配时失败", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dir = w.ensureTaskExecutionWorkspace("mismatch-owner");
  const manifestPath = join(dir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify({ version: 1, taskId: "another-task", createdAt: 1 }));
  assert.throws(() => w.ensureTaskExecutionWorkspace("mismatch-owner"), TaskManifestMismatchError);
  assert.throws(() => w.readManifest("mismatch-owner"), TaskManifestMismatchError);
  // 其他任务的 taskId 不能复用该目录
  const other = getTaskDirectoryName("another-task");
  assert.notEqual(join(workspacesRoot, other), dir, "不同 taskId 物理目录本就不同，篡改清单后必须报错");
});

/* ================================================================= */
/* manifest 原子写与损坏防护（§4.6）                                   */
/* ================================================================= */

check("manifest 损坏 JSON 报 TaskManifestError", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dir = w.ensureTaskExecutionWorkspace("corrupt-task");
  writeFileSync(join(dir, MANIFEST_FILENAME), "{ not json");
  assert.throws(() => w.ensureTaskExecutionWorkspace("corrupt-task"), TaskManifestError);
  assert.throws(() => w.readManifest("corrupt-task"), TaskManifestError);
});

check("manifest 不支持的 version 报错", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dir = w.ensureTaskExecutionWorkspace("version-task");
  writeFileSync(
    join(dir, MANIFEST_FILENAME),
    JSON.stringify({ version: 99, taskId: "version-task", createdAt: 1 }),
  );
  assert.throws(() => w.ensureTaskExecutionWorkspace("version-task"), TaskManifestError);
});

/* ================================================================= */
/* 词法边界（§4.4 / §12.6 前缀目录陷阱）                                */
/* ================================================================= */

check("isPathInsideOrEqual 基本语义", () => {
  const root = join(workspacesRoot, "lex");
  assert.equal(isPathInsideOrEqual(root, root), true, "等于自身");
  assert.equal(isPathInsideOrEqual(root, join(root, "a")), true, "直接子路径");
  assert.equal(isPathInsideOrEqual(root, join(root, "a", "b", "c.md")), true, "深层子路径");
  assert.equal(isPathInsideOrEqual(root, join(root, "a", "..", "b")), true, "内部 .. 归一化后仍在根内");
  assert.equal(isPathInsideOrEqual(root, join(root, "..", "x")), false, ".. 越界");
  assert.equal(isPathInsideOrEqual(root, resolve(root, "..")), false, "父目录");
});

check("前缀目录 task-1 / task-10 不被 startsWith 误判", () => {
  const fakeRoot = join(tempRoot, "siblings");
  mkdirSync(join(fakeRoot, "task-1"), { recursive: true });
  mkdirSync(join(fakeRoot, "task-10"), { recursive: true });
  const t1 = join(fakeRoot, "task-1");
  const t10 = join(fakeRoot, "task-10");
  assert.equal(isPathInsideOrEqual(t1, join(t10, "a.txt")), false, "task-10 不得被误判为 task-1 子路径");
  assert.equal(isPathInsideOrEqual(t10, join(t1, "a.txt")), false);
  assert.throws(() => assertPathInsideTask(t1, join(t10, "a.txt")), TaskPathBoundaryError);
});

if (process.platform === "win32") {
  check("win32 大小写不敏感边界（§4.4）", () => {
    const root = join(workspacesRoot, "CaseRoot");
    mkdirSync(root, { recursive: true });
    const upper = root.toUpperCase();
    assert.notEqual(root, upper, "路径大小写确有差异");
    assert.equal(isPathInsideOrEqual(root, upper), true, "大小写变化仍视为同一路径");
    assert.equal(isPathInsideOrEqual(root, join(upper, "Sub", "..", "x")), true);
    assert.equal(isPathInsideOrEqual(root, join(upper, "..", "Out")), false);
    // assertPathInsideTask 大小写变体通过
    assert.equal(assertPathInsideTask(root, join(upper, "notes.md")), resolve(join(upper, "notes.md")));
  });
} else {
  skip("win32 大小写不敏感边界", "非 Windows 平台，大小写敏感语义不同");
}

/* ================================================================= */
/* assertPathInsideTask：越界与兄弟任务（§4.5 / §12.6）                */
/* ================================================================= */

check("assertPathInsideTask：.. 穿越被拒", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dirA = w.ensureTaskExecutionWorkspace("traverse-A");
  const dirB = w.ensureTaskExecutionWorkspace("traverse-B");
  assert.throws(
    () => assertPathInsideTask(dirA, join(dirA, "..", "traverse-B", "b.md")),
    TaskPathBoundaryError,
  );
});

check("assertPathInsideTask：外部绝对路径被拒", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dir = w.ensureTaskExecutionWorkspace("abs-out");
  const outside = join(tempRoot, "outside.md");
  writeFileSync(outside, "x");
  assert.throws(() => assertPathInsideTask(dir, outside), TaskPathBoundaryError);
});

check("assertPathInsideTask：兄弟任务绝对路径被拒，任务内路径通过", () => {
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const dirA = w.ensureTaskExecutionWorkspace("sib-A");
  const dirB = w.ensureTaskExecutionWorkspace("sib-B");
  writeFileSync(join(dirB, "b.md"), "b");
  assert.throws(() => assertPathInsideTask(dirA, join(dirB, "b.md")), TaskPathBoundaryError);
  assert.throws(() => assertPathInsideTask(dirA, join(dirB, "..", "sib-A", "a.md")), TaskPathBoundaryError);

  const aFile = join(dirA, "sub", "a.md");
  mkdirSync(dirname(aFile), { recursive: true });
  writeFileSync(aFile, "a");
  assert.equal(assertPathInsideTask(dirA, aFile), resolve(aFile), "任务内路径返回规范化绝对路径");
  assert.equal(assertPathInsideTask(dirA, join(dirA, "sub", "..", "sub", "a.md")), resolve(aFile));
  // 不存在但父目录存在的目标：词法 + realpath 通过
  const pending = join(dirA, "sub", "future.md");
  assert.equal(assertPathInsideTask(dirA, pending), resolve(pending));
});

/* ================================================================= */
/* Junction / 符号链接逃逸（§4.5）                                     */
/* ================================================================= */

let junctionSkipped = false;
{
  const w = new TaskExecutionWorkspace(workspacesRoot);
  const taskDir = w.ensureTaskExecutionWorkspace("junction-task");
  const outsideDir = join(tempRoot, "junction-outside");
  mkdirSync(outsideDir, { recursive: true });
  const link = join(taskDir, "link");
  try {
    symlinkSync(outsideDir, link, "junction");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && ["EPERM", "EACCES", "ENOSYS", "EXDEV"].includes(e.code ?? "")) {
      skip("Junction 逃逸测试", `本环境无权限创建 Junction（${e.code} ${e.message}）`);
      junctionSkipped = true;
    } else {
      throw err;
    }
  }
  if (!junctionSkipped) {
    check("Junction 逃逸：词法层判定 inside，realpath 层拒绝", () => {
      const escaped = join(link, "evil.md");
      assert.equal(isPathInsideOrEqual(taskDir, escaped), true, "词法层应判定在任务目录内（这正是需要 realpath 层的原因）");
      assert.throws(() => assertPathInsideTask(taskDir, escaped), TaskPathBoundaryError);
    });
    check("Junction 逃逸：已存在的越界文件同样被拒", () => {
      const realFile = join(outsideDir, "real-evil.md");
      writeFileSync(realFile, "outside");
      assert.throws(() => assertPathInsideTask(taskDir, join(link, "real-evil.md")), TaskPathBoundaryError);
    });
    check("Junction 逃逸：link 内合法文件必须落在任务目录内", () => {
      // link 指向任务目录内的子目录 → 允许
      const inner = join(taskDir, "inner");
      mkdirSync(inner, { recursive: true });
      const innerLink = join(taskDir, "inner-link");
      symlinkSync(inner, innerLink, "junction");
      const through = join(innerLink, "ok.md");
      assert.equal(assertPathInsideTask(taskDir, through), resolve(through), "指向任务内的 Junction 应通过");
    });
  }
}

/* ================================================================= */
/* 测试注入（构造参数 + setTaskExecutionWorkspacesRootForTests）                       */
/* ================================================================= */

check("构造参数注入 workspaces root（测试用临时目录）", () => {
  const altRoot = join(tempRoot, "alt-workspaces");
  const w = new TaskExecutionWorkspace(altRoot);
  assert.equal(w.getTaskExecutionWorkspacesRoot(), resolve(altRoot));
  const dir = w.ensureTaskExecutionWorkspace("inject-task");
  assert.ok(dir.startsWith(resolve(altRoot) + sep), `目录必须位于注入的 root 下：${dir}`);
  assert.ok(existsSync(join(dir, MANIFEST_FILENAME)));
});

check("不同实例的 root 互不影响", () => {
  const rootA = join(tempRoot, "wsA");
  const rootB = join(tempRoot, "wsB");
  const wA = new TaskExecutionWorkspace(rootA);
  const wB = new TaskExecutionWorkspace(rootB);
  const dirA = wA.ensureTaskExecutionWorkspace("task-x");
  const dirB = wB.ensureTaskExecutionWorkspace("task-x");
  assert.notEqual(dirA, dirB);
  assert.ok(dirA.startsWith(resolve(rootA) + sep));
  assert.ok(dirB.startsWith(resolve(rootB) + sep));
});

check("setTaskExecutionWorkspacesRootForTests 覆盖模块级默认实例", () => {
  const altRoot2 = join(tempRoot, "mod-inject");
  setTaskExecutionWorkspacesRootForTests(altRoot2);
  assert.equal(getTaskExecutionWorkspacesRoot(), resolve(altRoot2));
  const dir = ensureTaskExecutionWorkspace("mod-inject-task");
  assert.ok(isPathInsideOrEqual(altRoot2, dir));
  assert.ok(existsSync(join(dir, MANIFEST_FILENAME)));
  const viaFn = resolveTaskExecutionWorkspaceDir("mod-inject-task");
  assert.equal(viaFn, dir, "模块级 resolveTaskExecutionWorkspaceDir 与 ensureTaskExecutionWorkspace 使用同一注入 root");
});

/* ================================================================= */
/* 生产接线（§4.3 / DoD）：getTaskExecutionWorkspacesDir() 映射验证                    */
/* 纯读校验：仅当真实目录已存在时执行，不写入任何测试数据                 */
/* ================================================================= */

const realWorkspaces = join(homedir(), ".mybuddy", "task-workspaces");
if (existsSync(realWorkspaces)) {
  check("getTaskExecutionWorkspacesDir() 返回 ~/.mybuddy/task-workspaces（迁移后）", () => {
    assert.equal(getTaskExecutionWorkspacesDir(), realWorkspaces);
  });
} else {
  skip(
    "getTaskExecutionWorkspacesDir() 生产接线",
    "本机不存在 ~/.mybuddy/task-workspaces，跳过以免触发真实目录迁移",
  );
}

/* ================================================================= */
/* 阶段 2：DB bind + 主进程权威 cwd（§5.2 / §6 / §7）                   */
/* 全部使用临时 sqlite + 临时 workspaces root，不碰真实 ~/.mybuddy    */
/* ================================================================= */

const stageDbRoot = mkdtempSync(join(tmpdir(), "mybuddy-stage2-"));
const stageDbPath = join(stageDbRoot, "app.db");
const stageDb = new AppDatabase(stageDbPath);
const dbWs = new TaskExecutionWorkspace(join(stageDbRoot, "task-workspaces"));

check("bindTaskExecutionWorkspaceCwd：首建最小行（Renderer 尚未 upsert）", () => {
  const cwd = dbWs.ensureTaskExecutionWorkspace("db-minimal");
  stageDb.bindTaskExecutionWorkspaceCwd("db-minimal", cwd);
  const row = stageDb.getTask("db-minimal");
  assert.ok(row, "主进程应能建立最小任务行");
  assert.equal(row!.cwd, cwd);
  assert.equal(row!.title, "新任务");
  assert.equal(row!.sessionFile, undefined);
  assert.equal(row!.archived, false);
});

check("bindTaskExecutionWorkspaceCwd：只更新 cwd/updated_at，不覆盖其他字段（§5.2）", () => {
  const id = "db-preserve";
  stageDb.upsertTask({
    id,
    title: "自定义标题",
    updatedAt: Date.now(),
    spaceId: undefined,
    sessionFile: join(stageDbRoot, "s.json"),
    modelId: "openai/gpt-x",
    permissionMode: "default",
    welcomeMode: "working",
    expertId: "expert-a",
    modePresetId: "preset-1",
  });
  // archived 由 archiveTask 写入（upsertTask 不落 archived 列，这是既有 API 语义）
  stageDb.archiveTask(id, true);
  const cwd = dbWs.ensureTaskExecutionWorkspace(id);
  stageDb.bindTaskExecutionWorkspaceCwd(id, cwd);
  const row = stageDb.getTask(id)!;
  assert.equal(row.cwd, cwd, "cwd 更新为 canonical");
  assert.equal(row.title, "自定义标题");
  assert.equal(row.sessionFile, join(stageDbRoot, "s.json"));
  assert.equal(row.modelId, "openai/gpt-x");
  assert.equal(row.permissionMode, "default");
  assert.equal(row.welcomeMode, "working");
  assert.equal(row.archived, true, "bind 不得清掉 archived");
  assert.equal(row.expertId, "expert-a");
  assert.equal(row.modePresetId, "preset-1");
});

check("重启模拟：新 AppDatabase 实例读回 cwd", () => {
  const db2 = new AppDatabase(stageDbPath);
  const row = db2.getTask("db-preserve");
  assert.equal(row?.cwd, dbWs.resolveTaskExecutionWorkspaceDir("db-preserve"));
  assert.equal(row?.title, "自定义标题", "重启后其他字段不变");
  (db2 as unknown as { db: { close(): void } }).db.close();
});

check("assertTaskExecutionWorkspaceDir：canonical 通过 / 伪造 cwd 拒绝（§7.2 防线）", () => {
  const w = new TaskExecutionWorkspace(join(stageDbRoot, "task-workspaces"));
  const canonical = w.ensureTaskExecutionWorkspace("assert-dir");
  assert.doesNotThrow(() => w.assertTaskExecutionWorkspaceDir("assert-dir", canonical));
  assert.throws(() => w.assertTaskExecutionWorkspaceDir("assert-dir", join(stageDbRoot, "other", "x")), TaskExecutionWorkspaceError);
  assert.throws(() => w.assertTaskExecutionWorkspaceDir("assert-dir", join(canonical, "..", "elsewhere")), TaskExecutionWorkspaceError);
  assert.throws(() => w.assertTaskExecutionWorkspaceDir("assert-dir", ""), TaskExecutionWorkspaceError);
  if (process.platform === "win32") {
    assert.doesNotThrow(
      () => w.assertTaskExecutionWorkspaceDir("assert-dir", canonical.toUpperCase()),
      "win32 大小写变体视为同一目录",
    );
  }
});

/* ----------------------------------------------------------------- */
/* 主进程权威 cwd 契约（与 AgentService.resolveTaskExecutionWorkspaceCwd 同序）：  */
/* ensureTaskExecutionWorkspace → bindTaskExecutionWorkspaceCwd；忽略任何伪造 Renderer cwd。  */
/* （完整 AgentService 集成依赖 pi-coding-agent CJS 导出，单独做 e2e）  */
/* ----------------------------------------------------------------- */

const svcRoot = join(stageDbRoot, "svc-workspaces");
const svcWs = new TaskExecutionWorkspace(svcRoot);
const svcDb = new AppDatabase(join(stageDbRoot, "svc-app.db"));

/** 与 AgentService.resolveTaskExecutionWorkspaceCwd 相同的两步权威解析 */
function resolveTaskExecutionWorkspaceCwdLikeAgent(taskId: string): string {
  const cwd = svcWs.ensureTaskExecutionWorkspace(taskId);
  svcDb.bindTaskExecutionWorkspaceCwd(taskId, cwd);
  return cwd;
}

function stage2Integration(): void {
  check("主进程权威 cwd：伪造 Renderer cwd 被忽略，canonical 建目录+落库", () => {
    const taskId = "fake-cwd-task";
    const fakeCwd = join(stageDbRoot, "renderer-space");
    // 故意不使用 fakeCwd：主进程只看 taskId
    const canonical = resolveTaskExecutionWorkspaceCwdLikeAgent(taskId);
    assert.ok(existsSync(canonical), "canonical 任务目录已创建");
    assert.ok(existsSync(join(canonical, MANIFEST_FILENAME)), "manifest 已创建");
    assert.ok(!existsSync(fakeCwd), "伪造 renderer cwd 目录不得被创建/使用");
    const row = svcDb.getTask(taskId);
    assert.ok(row, "主进程已建立任务行");
    assert.equal(row!.cwd, canonical, "DB cwd = canonical task root（req.cwd 被忽略）");
    assert.notEqual(row!.cwd, fakeCwd);
  });

  check("主进程权威 cwd：旧共享 cwd 懒迁移，不移动旧文件", () => {
    const taskId = "regen-task";
    const legacyCwd = join(stageDbRoot, "legacy-shared-cwd");
    mkdirSync(legacyCwd, { recursive: true });
    writeFileSync(join(legacyCwd, "old.md"), "old"); // 旧共享目录文件：不得被移动/删除
    svcDb.upsertTask({
      id: taskId,
      title: "旧任务",
      updatedAt: Date.now(),
      spaceId: undefined,
      sessionFile: join(stageDbRoot, "fake-session.jsonl"),
      cwd: legacyCwd, // 模拟升级前的旧共享 cwd
    });
    const canonical = resolveTaskExecutionWorkspaceCwdLikeAgent(taskId);
    const row = svcDb.getTask(taskId)!;
    assert.equal(row.cwd, canonical, "DB cwd 被 bind 为 canonical（旧共享 cwd 懒迁移）");
    assert.notEqual(row.cwd, legacyCwd);
    assert.ok(existsSync(join(canonical, MANIFEST_FILENAME)), "canonical 目录已建立");
    assert.ok(existsSync(join(legacyCwd, "old.md")), "旧共享目录文件不得被移动/删除");
  });
}

/* ================================================================= */
/* 阶段 4b：Artifact 边界（§10.2 / 并发门禁）                          */
/* ================================================================= */

const artDb = new AppDatabase(join(stageDbRoot, "art-app.db"));
const artService = new ArtifactService(
  new ArtifactStorage(join(stageDbRoot, "artifact-store")),
  new ArtifactRepository(artDb.connection),
  new ArtifactRegistry(),
);
const artCoord = new ArtifactRefreshCoordinator(artService);

async function stage4Artifact(): Promise<void> {
  await checkAsync("ArtifactService.register：workspace-file entryFile 越出 rootDir 拒绝且不落库（§10.2）", async () => {
    const w = new TaskExecutionWorkspace(join(stageDbRoot, "task-workspaces"));
    const dirA = w.ensureTaskExecutionWorkspace("art-A");
    writeFileSync(join(dirA, "a.md"), "a");
    const outside = join(stageDbRoot, "outside.md");
    writeFileSync(outside, "outside");
    await assert.rejects(
      artService.register({
        taskId: "art-A",
        kind: "markdown",
        title: "evil",
        workspaceFile: { entryFile: outside, rootDir: dirA },
      }),
      /rootDir 内/,
    );
    assert.equal(artService.listByTask("art-A").length, 0, "越界注册不得落库");
  });

  await checkAsync("并发门禁：A/B 独立 root，A 只登记 a.md，B 只登记 b.md，互不 bump（§11 核心门禁）", async () => {
    const wA = new TaskExecutionWorkspace(join(stageDbRoot, "conc-a"));
    const wB = new TaskExecutionWorkspace(join(stageDbRoot, "conc-b"));
    const dirA = wA.ensureTaskExecutionWorkspace("conc-A");
    const dirB = wB.ensureTaskExecutionWorkspace("conc-B");

    // 1) A 前置 snapshot（无文件）
    const beforeA = await snapshotWorkspace(dirA);
    // 2) B 写 b.md（隔离目录，A 不可见）
    writeFileSync(join(dirB, "b.md"), "b");
    // 3) A 写 a.md + 后置 snapshot
    writeFileSync(join(dirA, "a.md"), "a");
    const afterA = await snapshotWorkspace(dirA);
    const changedA = [...afterA.keys()].filter((f) => beforeA.get(f) !== afterA.get(f));
    assert.deepEqual(
      changedA.map((f) => basename(f)),
      ["a.md"],
      "A 的后置快照不得包含 B 的 b.md（隔离根生效）",
    );

    // A 回合登记 a.md；B 回合登记 b.md
    await artService.register({
      taskId: "conc-A",
      kind: "markdown",
      title: "a.md",
      workspaceFile: { entryFile: join(dirA, "a.md"), rootDir: dirA },
    });
    await artService.register({
      taskId: "conc-B",
      kind: "markdown",
      title: "b.md",
      workspaceFile: { entryFile: join(dirB, "b.md"), rootDir: dirB },
    });
    const artA = artService.findByEntryFile("conc-A", join(dirA, "a.md"))!;
    const artB = artService.findByEntryFile("conc-B", join(dirB, "b.md"))!;
    assert.ok(artA && artB, "A/B 各登记自己的 Artifact");
    assert.equal(artA.version, 1);
    assert.equal(artB.version, 1);

    // 4) B 回合刷新（b.md 变化）→ 只 bump B
    writeFileSync(join(dirB, "b.md"), "b2");
    const evtsB = await artCoord.onWorkspaceChanged({
      taskId: "conc-B",
      cwd: dirB,
      changedFiles: [join(dirB, "b.md")],
    });
    assert.equal(evtsB.length, 1);
    assert.equal(evtsB[0].artifactId, artB.id);
    assert.equal(evtsB[0].version, 2);
    assert.equal(
      artService.findByEntryFile("conc-A", join(dirA, "a.md"))!.version,
      1,
      "B 的修改不能 bump A Artifact version",
    );

    // 5) A 回合刷新 → 只 bump A
    writeFileSync(join(dirA, "a.md"), "a2");
    const evtsA = await artCoord.onWorkspaceChanged({
      taskId: "conc-A",
      cwd: dirA,
      changedFiles: [join(dirA, "a.md")],
    });
    assert.equal(evtsA.length, 1);
    assert.equal(evtsA[0].version, 2);
    assert.equal(
      artService.findByEntryFile("conc-B", join(dirB, "b.md"))!.version,
      2,
      "A 的修改不能 bump B",
    );
  });

  await checkAsync("markFilesChanged：不一致 root / 越界 changedFiles / manifest 均不刷新（§10.2/§10.3）", async () => {
    // 旧共享 root Artifact：rootDir=共享目录；新事件 cwd=canonical → 不得刷新
    const sharedRoot = join(stageDbRoot, "legacy-shared");
    mkdirSync(sharedRoot, { recursive: true });
    writeFileSync(join(sharedRoot, "legacy.md"), "l");
    await artService.register({
      taskId: "legacy-task",
      kind: "markdown",
      title: "legacy",
      workspaceFile: { entryFile: join(sharedRoot, "legacy.md"), rootDir: sharedRoot },
    });
    assert.equal(artService.findByEntryFile("legacy-task", join(sharedRoot, "legacy.md"))!.version, 1);

    const canonicalRoot = join(stageDbRoot, "canonical-new");
    mkdirSync(canonicalRoot, { recursive: true });
    writeFileSync(join(canonicalRoot, "new.md"), "n");
    const evts = await artCoord.onWorkspaceChanged({
      taskId: "legacy-task",
      cwd: canonicalRoot,
      changedFiles: [join(canonicalRoot, "new.md")],
    });
    assert.equal(evts.length, 0, "旧共享 root Artifact 不被新 canonical task event 刷新");
    assert.equal(
      artService.findByEntryFile("legacy-task", join(sharedRoot, "legacy.md"))!.version,
      1,
    );

    // 越界 changedFiles 被过滤：只有 root 内文件能触发刷新
    await artService.register({
      taskId: "legacy-task",
      kind: "markdown",
      title: "new",
      workspaceFile: { entryFile: join(canonicalRoot, "new.md"), rootDir: canonicalRoot },
    });
    const evts2 = await artCoord.onWorkspaceChanged({
      taskId: "legacy-task",
      cwd: canonicalRoot,
      changedFiles: [join(canonicalRoot, "new.md"), join(stageDbRoot, "outside.md")],
    });
    assert.equal(evts2.length, 1, "越界 changedFiles 被过滤，只剩 root 内文件");
    assert.equal(evts2[0].artifactId, artService.findByEntryFile("legacy-task", join(canonicalRoot, "new.md"))!.id);

    // manifest / 内部临时文件不参与刷新
    const mf = join(canonicalRoot, MANIFEST_FILENAME);
    writeFileSync(mf, JSON.stringify({ version: 1, taskId: "legacy-task", createdAt: 1 }));
    const evts3 = await artCoord.onWorkspaceChanged({
      taskId: "legacy-task",
      cwd: canonicalRoot,
      changedFiles: [mf],
    });
    assert.equal(evts3.length, 0, "manifest 变化不得 bump Artifact");

    // taskId / cwd 缺失 → 空结果
    assert.equal(
      (await artCoord.onWorkspaceChanged({ taskId: "", cwd: canonicalRoot, changedFiles: [mf] })).length,
      0,
    );
    assert.equal(
      (await artCoord.onWorkspaceChanged({ taskId: "legacy-task", cwd: "", changedFiles: [mf] })).length,
      0,
    );
  });
}

/* ================================================================= */
/* 阶段 4c：WorkspaceService 快照/文件树忽略 manifest（§5.4）           */
/* ================================================================= */

async function stage4Workspace(): Promise<void> {
  await checkAsync("snapshotWorkspace / listWorkspaceFiles 忽略 .mybuddy-task.json 与内部临时文件", async () => {
    const w = new TaskExecutionWorkspace(join(stageDbRoot, "task-workspaces"));
    const dir = w.ensureTaskExecutionWorkspace("snap-task");
    writeFileSync(join(dir, "ok.md"), "ok");
    writeFileSync(join(dir, "page.html"), "<!doctype html>");
    writeFileSync(join(dir, "car.blend"), "BLENDER");
    writeFileSync(join(dir, `${MANIFEST_FILENAME}.1234.abcd${MANIFEST_TMP_SUFFIX}`), "partial");
    mkdirSync(join(dir, "_freecad_scripts"), { recursive: true });
    writeFileSync(join(dir, "_freecad_scripts", "fc_tmp.py"), "print(1)");
    const snap = await snapshotWorkspace(dir);
    const names = [...snap.keys()].map((k) => basename(k));
    assert.ok(names.includes("ok.md"));
    assert.ok(names.includes("page.html"), "html 必须进入快照（黑名单不挡变更）");
    assert.ok(names.includes("car.blend"), "blend 必须进入快照（黑名单不挡变更）");
    assert.ok(names.includes("fc_tmp.py"), "磁盘实文件进入快照；产物显示过滤另算");
    assert.ok(!names.includes(MANIFEST_FILENAME), "manifest 不得进入快照");
    assert.ok(
      !names.some((n) => n.endsWith(MANIFEST_TMP_SUFFIX)),
      "清单临时文件不得进入快照",
    );
    const tree = await listWorkspaceFiles(dir);
    const treeJson = JSON.stringify(tree);
    assert.ok(treeJson.includes("page.html"), "工作空间文件树列出 html");
    assert.ok(treeJson.includes("car.blend"), "工作空间文件树列出 blend");
    assert.ok(treeJson.includes("fc_tmp.py"), "工作空间文件树列出磁盘实文件");
    assert.ok(!treeJson.includes(MANIFEST_FILENAME), "manifest 不得出现在文件树");
  });

  await checkAsync("create/rename/move 工作区文件并拒绝逃逸", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-mut-"));
    try {
      const created = await createWorkspacePath(dir, "", "note.md", "file");
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const folder = await createWorkspacePath(dir, "", "docs", "folder");
      assert.equal(folder.ok, true);
      if (!folder.ok) return;
      const moved = await moveWorkspacePath(dir, created.relativePath, folder.relativePath);
      assert.equal(moved.ok, true);
      if (!moved.ok) return;
      assert.equal(moved.relativePath, "docs/note.md");
      const renamed = await renameWorkspacePath(dir, moved.relativePath, "readme.md");
      assert.equal(renamed.ok, true);
      if (!renamed.ok) return;
      assert.equal(renamed.relativePath, "docs/readme.md");
      const tree = await listWorkspaceFiles(dir);
      const json = JSON.stringify(tree);
      assert.ok(json.includes("docs"), "空文件夹也要出现在文件树");
      assert.ok(json.includes("readme.md"));
      const escapeRename = await renameWorkspacePath(dir, "docs/readme.md", "../out.md");
      assert.equal(escapeRename.ok, false, "名称含分隔符必须拒绝");
      const selfMove = await moveWorkspacePath(dir, "docs", "docs");
      assert.equal(selfMove.ok, false, "不能将文件夹移入自身");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync("copyExternalIntoWorkspace 复制文件/文件夹并跳过已在区内", async () => {
    const dest = mkdtempSync(join(tmpdir(), "ws-copy-dest-"));
    const srcRoot = mkdtempSync(join(tmpdir(), "ws-copy-src-"));
    try {
      const file = join(srcRoot, "note.md");
      writeFileSync(file, "hello");
      const folder = join(srcRoot, "pack");
      mkdirSync(folder);
      writeFileSync(join(folder, "inner.txt"), "in");
      const copied = await copyExternalIntoWorkspace(dest, file);
      assert.equal(copied.ok, true);
      if (!copied.ok) return;
      assert.equal(copied.alreadyThere, false);
      assert.equal(copied.relativePath, "note.md");
      assert.equal(readFileSync(join(dest, "note.md"), "utf8"), "hello");
      const again = await copyExternalIntoWorkspace(dest, join(dest, "note.md"));
      assert.equal(again.ok, true);
      if (!again.ok) return;
      assert.equal(again.alreadyThere, true);
      const folderCopy = await copyExternalIntoWorkspace(dest, folder);
      assert.equal(folderCopy.ok, true);
      if (!folderCopy.ok) return;
      assert.equal(folderCopy.relativePath, "pack");
      assert.equal(readFileSync(join(dest, "pack", "inner.txt"), "utf8"), "in");
      const conflict = await copyExternalIntoWorkspace(dest, file);
      assert.equal(conflict.ok, true);
      if (!conflict.ok) return;
      assert.equal(conflict.relativePath, "note (1).md");
      const rootCopy = await copyExternalIntoWorkspace(dest, dest);
      assert.equal(rootCopy.ok, false, "不能复制工作区根目录");
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(srcRoot, { recursive: true, force: true });
    }
  });
}

/* ================================================================= */
/* 2026-11-06 回归：一句「你好」把整个项目目录登记成产物               */
/* ================================================================= */

async function stageWorkspaceArtifactDiff(): Promise<void> {
  await checkAsync("产物快照忽略 build/intermediates 等生成目录，但文件树仍列出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-snap-gen-"));
    try {
      const generated = join(dir, "app", "remote", "android", "app", "build", "intermediates");
      mkdirSync(generated, { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(generated, "splash.png"), "PNG");
      writeFileSync(join(dir, "app", "remote", "android", "app", "build", "file-to-id.tab.values.at"), "tab");
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1");
      writeFileSync(join(dir, "README.md"), "hello");

      const snap = await snapshotWorkspace(dir);
      const names = [...snap.keys()].map((p) => basename(p));
      assert.ok(names.includes("README.md"), "普通项目文件必须进入 baseline");
      assert.ok(!names.includes("splash.png"), "build/intermediates 下文件不得进产物快照");
      assert.ok(!names.includes("file-to-id.tab.values.at"), "build 下文件不得进产物快照");
      assert.ok(!names.includes("index.js"), "node_modules 下文件不得进产物快照");
      assert.ok(
        JSON.stringify(await listWorkspaceFiles(dir)).includes("splash.png"),
        "快照过滤不等于隐藏文件：文件树仍应列出构建产物",
      );
      assert.equal(isGeneratedWorkspacePath(join(generated, "splash.png"), dir), true);
      assert.equal(isGeneratedWorkspacePath(join(dir, "README.md"), dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await checkAsync("既有大目录 + 纯文本轮次（只发「你好」）：diff 必须为空", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-snap-idle-"));
    try {
      for (let i = 0; i < 120; i += 1) {
        writeFileSync(join(dir, `existing-${i}.ts`), `export const n = ${i};`);
      }
      const before = await snapshotWorkspace(dir);
      // 模拟一轮纯文本对话：目录没有任何写入
      const after = await snapshotWorkspace(dir);
      const diff = diffWorkspaceSnapshot(before, after);
      assert.equal(before.size, 120, "既有文件全部进入 baseline");
      assert.equal(diff.rejected, undefined, "正常 idle 轮次不得被保险丝拒绝");
      assert.deepEqual(diff.changed, [], "纯文本轮次不得把既有文件判为本轮产物");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("基线口径不一致（旧 unfiltered baseline）→ 整轮 diff 被拒绝，不返回全量 changed", () => {
    const root = join("C:", "repo");
    const before = new Map<string, string>([
      [join(root, ".git", "objects", "a"), "1:1"],
      [join(root, "node_modules", "pkg", "index.js"), "1:1"],
      [join(root, "out", "main.js"), "1:1"],
    ]);
    const after = new Map<string, string>([
      [join(root, "src", "a.ts"), "1:1"],
      [join(root, "docs", "b.md"), "1:1"],
      [join(root, "README.md"), "1:1"],
    ]);
    const diff = diffWorkspaceSnapshot(before, after);
    assert.ok(diff.rejected?.includes("基线失配"), `应拒绝，实际：${JSON.stringify(diff)}`);
    assert.deepEqual(diff.changed, []);
  });

  await checkAsync("真实单文件写入仍被 diff 捕获，且下一轮不重复登记", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-snap-write-"));
    try {
      const before = await snapshotWorkspace(dir);
      writeFileSync(join(dir, "result.md"), "done");
      const after = await snapshotWorkspace(dir);
      const diff = diffWorkspaceSnapshot(before, after);
      assert.equal(diff.rejected, undefined);
      assert.deepEqual(diff.changed.map((p) => basename(p)), ["result.md"]);
      const next = diffWorkspaceSnapshot(after, await snapshotWorkspace(dir));
      assert.deepEqual(next.changed, [], "下一轮 baseline 重拍后不得重复登记");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("单轮变化超过上限 → 拒绝整轮 diff，不灌入产物列表", () => {
    const after = new Map<string, string>();
    for (let i = 0; i < MAX_TURN_WORKSPACE_CHANGES + 1; i += 1) {
      after.set(join("C:", "ws", `f${i}.ts`), "1:1");
    }
    const diff = diffWorkspaceSnapshot(new Map(), after);
    assert.ok(diff.rejected?.includes("超过上限"), `应拒绝，实际：${JSON.stringify(diff)}`);
    assert.deepEqual(diff.changed, []);
  });
}

/* ================================================================= */
/* 汇总与清理                                                         */
/* ================================================================= */

async function main(): Promise<void> {
  stage2Integration();
  await stage4Artifact();
  await stage4Workspace();
  await stageWorkspaceArtifactDiff();

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "-".repeat(72));
  console.log(`task-workspace-isolation: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`FAILED: ${f.name} — ${f.detail}`);
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(stageDbRoot, { recursive: true, force: true });
    process.exitCode = 1;
  } else {
    (stageDb as unknown as { db: { close(): void } }).db.close();
    (svcDb as unknown as { db: { close(): void } }).db.close();
    (artDb as unknown as { db: { close(): void } }).db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(stageDbRoot, { recursive: true, force: true });
    console.log("tempRoot 已清理:", tempRoot);
    console.log("stageDbRoot 已清理:", stageDbRoot);
  }
}

void main().catch((err) => {
  console.error("测试执行异常:", err);
  process.exitCode = 1;
});
