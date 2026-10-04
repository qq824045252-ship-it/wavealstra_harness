/**
 * Wave 5 Real Open — 真实 Product Path E2E（V3.5 hotfix §19-24）
 *
 * 不再走 fixture → blobToDataUrl → Viewer 的 Viewer-only 链，而是完整真实链：
 *
 *   真实 Electron
 *   → 真实 ArtifactService/Repository/Storage（临时 DB + 临时存储）
 *   → ipcMain 真实通道（readContent/register/snapshot…）
 *   → 真实 preload 桥 → 真实 appStore（projection 事件 + hydrateArtifacts）
 *   → openArtifact(id) → ensureArtifactRenderPayload → readContent IPC
 *   → ArtifactService.readContent → WorkspaceService.previewWorkspaceFile
 *   → data URI → renderCache（version 绑定）→ ArtifactPanel → 真实 Viewer
 *
 * 场景：
 *   E1 DOCX（cache-empty → open → 自动 hydration → 正文显示）
 *   E2 XLSX（sheet tab + cell 内容）
 *   E3 PPTX（slideCount > 0 + slide 渲染，无 Corrupted zip）
 *   E4 PDF（page slots）
 *   E5 Image（naturalWidth > 0）
 *   E6 重启恢复（新窗口 = 新 renderer = cache 空 → 历史 artifact 自动 hydration）
 *   E7 Artifact Updated（磁盘覆盖 + markFilesChanged → v7 cache invalidate → v8 重 hydrate）
 *   E9 Artifact Removed（removed → cache/loadState 全清，不复活）
 *   E10 并发打开去重（×5 → readContent IPC 只 1 次）
 *
 * 前置：node scripts/build-wave5-real-open.mjs（真实 store bundle）
 * 运行：pnpm test:artifact-open-e2e
 */
import { app, BrowserWindow, ipcMain } from "electron";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { ArtifactDomainIpc } from "../src/shared/artifact-ipc";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";

/**
 * EPIPE 防护（栈：console.log → check → e1Docx → run 的 Electron 主进程弹窗）。
 *
 * 根因：本 E2E 由 `electron out/tests/wave5-real-open-e2e.cjs` 直接运行（GUI 子系统进程）。
 * 在 pnpm/IDE 终端/管道消费方提前关闭 stdout|stderr 时，测试进程后续 console.log
 * 写入失败会以 `Error: EPIPE: broken pipe, write` 触发 Node uncaughtException，
 * Electron 主进程随即弹「Uncaught Exception」对话框——与测试结果无关，纯日志管道问题。
 *
 * 正确边界：仅对标准流的 EPIPE 静默（输出已无处可去，日志丢失可接受）；
 * 其他流错误（EIO 等）与一切业务异常仍走默认崩溃路径，不吞。
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}

const ROOT = process.cwd();
const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const PAGE =
  "file:///" + join(ROOT, "fixtures", "golden-pages", "wave5-real-open.html").replace(/\\/g, "/");
const PRELOAD = join(ROOT, "out", "tests", "wave5-real-open-preload.cjs");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  wc: Electron.WebContents,
  expr: string,
  timeout = 40000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await wc.executeJavaScript(expr)) return true;
    } catch {
      /* 页面加载中 */
    }
    await sleep(150);
  }
  console.log(`  [waitFor] 超时: ${expr.slice(0, 110)}`);
  return false;
}

async function evalJson<T>(wc: Electron.WebContents, expr: string): Promise<T> {
  return (await wc.executeJavaScript(`(${expr})`)) as T;
}

const OPEN_STATE = `(() => {
  const st = window.__open.state();
  const viewer = document.querySelector('.artifact-panel .artifact-body');
  return {
    cache: st.cache,
    loads: st.loads,
    errors: st.errors,
    activeId: st.activeId,
    panelMode: st.panelMode,
    errorText: viewer?.textContent?.slice(0, 120) ?? '',
    loading: !!document.querySelector('[data-testid="artifact-render-loading"]'),
    errorBox: !!document.querySelector('[data-testid="artifact-render-error"]'),
  };
})()`;

// ---------- 场景 ----------

async function e1Docx(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('docx1')`);
  const ready = await waitFor(wc, `!!document.querySelector('.docx-viewer .docx-page-slot')`);
  check("E1 DOCX: 自动 hydration 并渲染页", ready);
  if (ready) {
    const s = await evalJson<any>(wc, OPEN_STATE);
    check("E1 DOCX: cache 已写入且 version 绑定", s.cache["docx1"]?.artifactVersion === 1);
    check("E1 DOCX: loadState ready", s.loads["docx1"] === "ready");
    const pageText = await evalJson<string>(wc, `document.querySelector('.docx-page-frame')?.textContent ?? ''`);
    check("E1 DOCX: 正文出现", /MyBuddy|Office|文档|DOCX/i.test(pageText), pageText.slice(0, 60));
    const err = await evalJson<string>(wc, `document.querySelector('.docx-viewer-status')?.textContent ?? ''`);
    check("E1 DOCX: 无 zip 错误", !err.includes("加载失败"), err);
    const dataUri = s.cache["docx1"]?.content ?? "";
    check("E1 DOCX: 内容为合法 docx data URI", dataUri.startsWith("data:") && dataUri.includes(";base64,") && dataUri.length > 200);
  }
}

async function e2Xlsx(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('xlsx1')`);
  const ready = await waitFor(wc, `!!document.querySelector('.xlsx-viewer .xlsx-sheet-tab')`);
  check("E2 XLSX: 自动 hydration 并渲染 sheet tab", ready);
  if (ready) {
    const s = await evalJson<any>(wc, OPEN_STATE);
    check("E2 XLSX: cache version 绑定", s.cache["xlsx1"]?.artifactVersion === 1);
    const cells = await evalJson<number>(wc, `document.querySelectorAll('.xlsx-cell').length`);
    check("E2 XLSX: cell 内容出现", cells > 0, String(cells));
    const err = await evalJson<string>(wc, `document.querySelector('.xlsx-viewer-status')?.textContent ?? ''`);
    check("E2 XLSX: 无 Corrupted zip", !err.includes("加载失败") && !err.includes("Corrupted"), err);
  }
}

async function e3Pptx(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('pptx1')`);
  const ready = await waitFor(wc, `!!document.querySelector('.pptx-viewer .pptx-stage-slide')`);
  check("E3 PPTX: 自动 hydration 并渲染 slide", ready);
  if (ready) {
    const s = await evalJson<any>(wc, OPEN_STATE);
    check("E3 PPTX: cache version 绑定", s.cache["pptx1"]?.artifactVersion === 1);
    const meta = await evalJson<string>(wc, `document.querySelector('.pptx-viewer-meta')?.textContent ?? ''`);
    check("E3 PPTX: slideCount > 0", /\d+ slides/.test(meta), meta);
    const err = await evalJson<string>(wc, `document.querySelector('.pptx-viewer-status')?.textContent ?? ''`);
    check("E3 PPTX: 无 Corrupted zip", !err.includes("加载失败") && !err.includes("Corrupted"), err);
    const title = await evalJson<string>(wc, `document.querySelector('.pptx-stage-slide.active .pptx-slide-inner')?.textContent ?? ''`);
    check("E3 PPTX: 标题文本", title.includes("MyBuddy PPTX"), title.slice(0, 50));
  }
}

async function e4Pdf(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('pdf1')`);
  const ready = await waitFor(wc, `!!document.querySelector('.pdf-viewer .pdf-page-slot')`);
  check("E4 PDF: 自动 hydration 并渲染页", ready);
  if (ready) {
    const slots = await evalJson<number>(wc, `document.querySelectorAll('.pdf-viewer .pdf-page-slot').length`);
    check("E4 PDF: pages > 0", slots > 0, String(slots));
    const err = await evalJson<string>(wc, `document.querySelector('.pdf-viewer-status')?.textContent ?? ''`);
    check("E4 PDF: 无加载错误", !err.includes("加载失败"), err);
  }
}

async function e5Image(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('img1')`);
  const ready = await waitFor(wc, `(() => { const img = document.querySelector('.image-viewer img'); return !!img && img.complete && img.naturalWidth > 0; })()`);
  check("E5 Image: 自动 hydration 且 naturalWidth > 0", ready);
  if (ready) {
    const s = await evalJson<any>(wc, OPEN_STATE);
    check("E5 Image: cache 已写入", !!s.cache["img1"]?.content, "");
  }
}

async function e7Updated(wc: Electron.WebContents, pptxPath: string, officeDir: string): Promise<void> {
  // 打开 24 slides deck（v1）
  await wc.executeJavaScript(`window.__open.open('pptxUpd')`);
  const ready = await waitFor(wc, `document.querySelector('.pptx-viewer-meta')?.textContent.includes('24 slides')`);
  check("E7 Updated: v1 打开（24 slides）", ready);
  // 磁盘覆盖为 4:3 双页 deck + RefreshCoordinator 路径（markFilesChanged → version++）
  // 注意：rootDir 前缀匹配语义——所有同 rootDir（含父级 FIX）的 workspace-file
  // artifact 都会被 bump；断言只针对 pptx-upd 事件本身。
  copyFileSync(join(FIX, "office", "pptx-43.pptx"), pptxPath);
  const updated = await service.markFilesChanged({
    taskId: "t1",
    cwd: officeDir,
    changedFiles: [pptxPath],
  });
  const updEvt = updated.find((u) => u.artifactId === "pptxUpd");
  check("E7 Updated: 主进程 version++ 事件", !!updEvt && updEvt.version === 2, JSON.stringify(updated.map((u) => `${u.artifactId}:v${u.version}`)));
  const reloaded = await waitFor(wc, `document.querySelector('.pptx-viewer-meta')?.textContent.includes('2 slides')`);
  check("E7 Updated: viewer 自动展示新版（2 slides）", reloaded);
  const s = await evalJson<any>(wc, OPEN_STATE);
  check("E7 Updated: cache.artifactVersion === 2", s.cache["pptxUpd"]?.artifactVersion === 2, String(s.cache["pptxUpd"]?.artifactVersion));
  const err = await evalJson<string>(wc, `document.querySelector('.pptx-viewer-status')?.textContent ?? ''`);
  check("E7 Updated: 无加载错误", !err.includes("加载失败"), err);
  // 恢复原始文件
  copyFileSync(join(tmpRoot, "pptx-long-backup.pptx"), pptxPath);
}

async function e9Removed(wc: Electron.WebContents): Promise<void> {
  await wc.executeJavaScript(`window.__open.open('xlsx1')`);
  await waitFor(wc, `!!document.querySelector('.xlsx-viewer .xlsx-sheet-tab')`);
  // 打开第二个 artifact（ppt 复用 pptx1）→ 两个 cache 都存在
  await wc.executeJavaScript(`window.__open.open('docx1')`);
  await waitFor(wc, `!!document.querySelector('.docx-viewer .docx-page-slot')`);
  // removed 事件 → cache/loadState/error 全清
  await wc.executeJavaScript(`window.__open.applyRemoved('docx1')`);
  await sleep(400);
  const s = await evalJson<any>(wc, OPEN_STATE);
  check("E9 Removed: cache 清除", !("docx1" in s.cache));
  check("E9 Removed: loadState 清除", !("docx1" in s.loads));
  // 原 xlsx cache 不受影响（并发打开的另一个 artifact）
  check("E9 Removed: 其他 cache 保留", !!s.cache["xlsx1"]);
}

async function e10Concurrent(wc: Electron.WebContents): Promise<void> {
  const before = readContentCalls.count;
  await wc.executeJavaScript(`(() => { for (let i = 0; i < 5; i++) window.__open.open('pptx1'); })()`);
  await waitFor(wc, `!!document.querySelector('.pptx-viewer .pptx-stage-slide')`);
  const after = readContentCalls.count;
  check("E10 并发: ×5 打开 readContent 只 1 次", after - before === 1, `+${after - before}`);
  const s = await evalJson<any>(wc, OPEN_STATE);
  check("E10 并发: viewer ready", s.loads["pptx1"] === "ready");
}

async function e6Restore(wc: Electron.WebContents): Promise<void> {
  // 新窗口 = 新 renderer = render cache 空（模拟应用重启）
  await wc.executeJavaScript(`window.__open.open('docx1')`);
  const ready = await waitFor(wc, `!!document.querySelector('.docx-viewer .docx-page-slot')`);
  check("E6 重启恢复: 历史 DOCX 自动 hydration", ready);
  await wc.executeJavaScript(`window.__open.open('pptx1')`);
  const ready2 = await waitFor(wc, `!!document.querySelector('.pptx-viewer .pptx-stage-slide')`);
  check("E6 重启恢复: 历史 PPTX 自动 hydration", ready2);
  if (ready2) {
    const s = await evalJson<any>(wc, OPEN_STATE);
    // 版本断言跟随 projection 当前版本（E7 的 markFilesChanged 可能已 bump 到 v2）
    const proj = await evalJson<any>(wc, `window.__open.state().descriptors ?? {}`);
    const descV = (id: string): number | undefined =>
      (proj["t1"] ?? []).find((d: any) => d.id === id)?.version;
    check(
      "E6 重启恢复: 两个 cache 均 version 绑定",
      s.cache["docx1"]?.artifactVersion === descV("docx1") &&
        s.cache["pptx1"]?.artifactVersion === descV("pptx1"),
      `docx1=${s.cache["docx1"]?.artifactVersion}@${descV("docx1")} pptx1=${s.cache["pptx1"]?.artifactVersion}@${descV("pptx1")}`,
    );
  }
}

// ---------- 装配 ----------

let service: ArtifactService;
let readContentCalls = { count: 0 };
let tmpRoot = "";

app.on("window-all-closed", () => {});

process.on("unhandledRejection", (reason) => {
  console.error("[real-open-e2e] unhandled rejection:", reason);
  app.exit(1);
});

async function run(): Promise<void> {
  await app.whenReady();
  tmpRoot = mkdtempSync(join(tmpdir(), "mybuddy-real-open-"));
  const db = new Database(join(tmpRoot, "test.db"));
  const storage = new ArtifactStorage(join(tmpRoot, "artifacts"));
  const repository = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  service = new ArtifactService(storage, repository, registry, {
    created: (e) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(ArtifactDomainIpc.created, e);
      }
    },
    updated: (e) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(ArtifactDomainIpc.updated, e);
      }
    },
    removed: (e) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(ArtifactDomainIpc.removed, e);
      }
    },
  });
  service.rebuildRegistry();

  ipcMain.handle(ArtifactDomainIpc.readContent, async (_e, req: { artifactId: string }) => {
    readContentCalls.count += 1;
    return service.readContent(req.artifactId);
  });
  ipcMain.handle(ArtifactDomainIpc.register, async (_e, req: never) => service.register(req));
  ipcMain.handle(ArtifactDomainIpc.snapshot, async (_e, req: { taskId: string }) =>
    service.hydrateTask(req.taskId),
  );
  ipcMain.handle(ArtifactDomainIpc.list, (_e, req: { taskId: string }) => ({
    artifacts: service.listByTask(req.taskId),
    state: "ready",
  }));
  ipcMain.handle(ArtifactDomainIpc.get, (_e, req: { artifactId: string }) => ({
    artifact: service.get(req.artifactId),
  }));
  ipcMain.handle(ArtifactDomainIpc.removeTask, (_e, req: { taskId: string }) =>
    service.removeByTask(req.taskId),
  );
  ipcMain.handle(ArtifactDomainIpc.remove, (_e, req: { artifactId: string }) => ({
    ok: service.remove(req.artifactId),
  }));

  // 测试 preload（真实通道子集；镜像真实 preload 的 artifactDomain 桥）
  mkdirSync(join(ROOT, "out", "tests"), { recursive: true });
  writeFileSync(
    PRELOAD,
    `const { contextBridge, ipcRenderer } = require("electron");
const bridge = (channel, cb) => {
  const h = (_e, ev) => cb(ev);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
const dom = {
  readContent: (req) => ipcRenderer.invoke("artifact-domain:readContent", req),
  register: (req) => ipcRenderer.invoke("artifact-domain:register", req),
  snapshot: (req) => ipcRenderer.invoke("artifact-domain:snapshot", req),
  list: (req) => ipcRenderer.invoke("artifact-domain:list", req),
  get: (req) => ipcRenderer.invoke("artifact-domain:get", req),
  removeTask: (req) => ipcRenderer.invoke("artifact-domain:removeTask", req),
  remove: (req) => ipcRenderer.invoke("artifact-domain:remove", req),
  onCreated: (cb) => bridge("artifact-domain:created", cb),
  onUpdated: (cb) => bridge("artifact-domain:updated", cb),
  onRemoved: (cb) => bridge("artifact-domain:removed", cb),
};
contextBridge.exposeInMainWorld("api", {
  artifactDomain: dom,
  agent: {
    onEvent: () => () => {},
    listModels: async () => [],
    listSkills: async () => [],
    getAppSettings: async () => null,
    listExperts: async () => [],
    listConnectors: async () => [],
  },
  db: { listTasks: async () => [], listSpaces: async () => [], getSoul: async () => null, updateSoul: async () => {} },
  selection: { get: async () => null, onChanged: () => () => {} },
  artifact: { close: () => {} },
  readWorkspaceFile: async () => null,
});`,
    "utf-8",
  );

  // 注册真实 workspace-file artifact（fixtures 指向磁盘文件 → readContent 走 previewWorkspaceFile）
  // 注意：register 不传 id 会生成随机 id；E2E 用固定逻辑 id 打开，必须显式传 id。
  const officeDir = join(FIX, "office");
  await service.register({
    id: "docx1",
    taskId: "t1",
    kind: "office",
    title: "DOCX 文档",
    capabilities: { originalKind: "docx" },
    workspaceFile: { entryFile: join(officeDir, "docx-simple.docx"), rootDir: officeDir },
  });
  await service.register({
    id: "xlsx1",
    taskId: "t1",
    kind: "office",
    title: "XLSX 表格",
    capabilities: { originalKind: "xlsx" },
    workspaceFile: { entryFile: join(officeDir, "xlsx-simple.xlsx"), rootDir: officeDir },
  });
  await service.register({
    id: "pptx1",
    taskId: "t1",
    kind: "office",
    title: "PPTX 演示",
    capabilities: { originalKind: "pptx" },
    workspaceFile: { entryFile: join(officeDir, "pptx-simple.pptx"), rootDir: officeDir },
  });
  await service.register({
    id: "pptxUpd",
    taskId: "t1",
    kind: "office",
    title: "PPTX 长文档",
    capabilities: { originalKind: "pptx" },
    workspaceFile: { entryFile: join(officeDir, "pptx-long-24p.pptx"), rootDir: officeDir },
  });
  await service.register({
    id: "pdf1",
    taskId: "t1",
    kind: "pdf",
    title: "PDF 文档",
    capabilities: { originalKind: "pdf" },
    workspaceFile: { entryFile: join(FIX, "pdf-simple.pdf"), rootDir: FIX },
  });
  await service.register({
    id: "img1",
    taskId: "t1",
    kind: "image",
    title: "PNG 图片",
    capabilities: { originalKind: "image" },
    workspaceFile: { entryFile: join(FIX, "image-basic.png"), rootDir: FIX },
  });
  const pptxUpdId = "pptxUpd";

  // E7 备份原始 long deck
  const pptxLongPath = join(officeDir, "pptx-long-24p.pptx");
  const backup = readFileSync(pptxLongPath);
  writeFileSync(join(tmpRoot, "pptx-long-backup.pptx"), backup);

  const makeWindow = (): BrowserWindow =>
    new BrowserWindow({
      width: 1300,
      height: 820,
      show: false,
      webPreferences: {
        preload: PRELOAD,
        webSecurity: false,
        contextIsolation: true,
      },
    });

  const scenarios: Array<[string, (wc: Electron.WebContents) => Promise<void>]> = [
    ["E1 DOCX", (wc) => e1Docx(wc)],
    ["E2 XLSX", (wc) => e2Xlsx(wc)],
    ["E3 PPTX", (wc) => e3Pptx(wc)],
    ["E4 PDF", (wc) => e4Pdf(wc)],
    ["E5 Image", (wc) => e5Image(wc)],
    ["E7 Updated", (wc) => e7Updated(wc, pptxLongPath, officeDir)],
    ["E9 Removed", (wc) => e9Removed(wc)],
    ["E10 Concurrent", (wc) => e10Concurrent(wc)],
  ];

  let failures = 0;
  const win = makeWindow();
  const consoleLines: string[] = [];
  win.webContents.on("console-message", (event: any) => {
    const d = event && typeof event === "object" && "message" in event ? event : null;
    if (d) consoleLines.push(String(d.message).slice(0, 300));
  });
  for (const [name, scenario] of scenarios) {
    try {
      console.log(`-- ${name} --`);
      await win.loadURL(PAGE);
      const ok = await waitFor(win.webContents, `!!window.__open && !!document.querySelector('.artifact-panel')`);
      if (!ok) {
        check(`${name}: 就绪`, false, "panel");
        failures += 1;
        continue;
      }
      await sleep(600);
      await scenario(win.webContents);
    } catch (error) {
      failures += 1;
      check(`${name}: 异常`, false, String(error));
    }
  }

  if (failures > 0 || results.some(([, pass]) => !pass)) {
    const bad = consoleLines.filter(
      (l) => !l.includes("%cElectron Security") && !l.includes("React DevTools") && !l.includes("disk_cache") && !l.includes("GPU") && !l.includes("Gpu"),
    );
    if (bad.length > 0) {
      console.log("--- renderer console（非安全警告）---");
      for (const l of bad.slice(-40)) console.log(`  | ${l.slice(0, 200)}`);
    }
  }

  // E6 重启恢复（新窗口 = 新 renderer）
  try {
    console.log("-- E6 Restore --");
    const win2 = makeWindow();
    await win2.loadURL(PAGE);
    const ok = await waitFor(win2.webContents, `!!window.__open && !!document.querySelector('.artifact-panel')`);
    if (!ok) {
      check("E6 重启恢复: 就绪", false);
      failures += 1;
    } else {
      await sleep(600);
      await e6Restore(win2.webContents);
    }
  } catch (error) {
    failures += 1;
    check("E6 重启恢复: 异常", false, String(error));
  }

  // 恢复 long deck 源文件（即使失败）
  try {
    copyFileSync(join(tmpRoot, "pptx-long-backup.pptx"), pptxLongPath);
  } catch {
    /* ignore */
  }

  const failed = results.filter(([, pass]) => !pass).length;
  console.log(`\n结果: ${results.length - failed}/${results.length} PASS`);
  app.exit(failures === 0 && failed === 0 ? 0 : 1);
}

void run();
