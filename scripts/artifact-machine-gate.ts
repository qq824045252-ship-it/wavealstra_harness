/**
 * Artifact Machine Gate — V3.5 §64/§98 机器化验证
 *
 * 验证「旧三份真相已被消灭」+ Wave 4A 显示决策收敛：
 *   1. rememberTaskArtifact 生产引用 = 0
 *   2. renderer 无 task.artifacts 直接读写 = 0
 *   3. ArtifactPreviewRequest.content 不存在 = 0
 *   4. PreviewHost registry 外部访问 = 0（registry 字段不存在 + 调用白名单）
 *   5. legacy artifact-index production writes = 0（只读 migration 源）
 *   6. 旧 9223 Capture Mode 脚本不存在（§99）
 *   7. renderer 业务组件直接 setRect/show/hide = 0（§75 Wave 4A Gate）
 *   8. PreviewHost 无 blocker/desiredVisible 业务状态（§102 ownership）
 *   9. PreviewHost 无 handleRequest/resolver/MIME/路径解析（§17 4B）
 *   10. protocol.handle 仅 ArtifactProtocol + PreviewHost 无 fs 直接读取（§17 机器锁） *   11. renderer 无 debugger/CDP 直接调用（§78 4C：业务组件不得碰 CDP）
 *   12. debugger.attach/detach/sendCommand 仅存在于 CdpElementInspector（4C 机器锁）
 *   13. Capture Mode 不拼 Prompt Context（§81 4C：MVP 不含 AI/上下文拼接）
 *   14. SelectionDescriptor 不由 UI 组件私有长期保存（§80 4D：组件只读投影）
 *   15. stale 判断只能存在于 SelectionStore / selection domain（4D 机器锁）
 *   16. SelectionStore 不允许引用 debugger/webContents/CDP（4D 纯数据）
 *   17. Prompt Context 拼装只在 PromptContextService/Formatter（4E 机器锁）
 *   18. PromptContextService 不直接 fs.readFile（4E：经 Domain 合法路径）
 *   19. PromptContextService 不允许 debugger/CDP/webContents（4E）
 *   20. stale selection 不得进入 trusted selection context（4E：显式处理）
 *   21. Binary Viewer 禁止直接读取 Artifact Domain（V3.5 hotfix：content 只经 props/hydration）
 *   22. render cache 必须绑定 artifactVersion（版本不一致 = stale，重新 readContent）
 *   23. missing binary content 不得当成 ready（空内容 → loading/error 门）
 *   24. pdfjs 主线程 / worker build flavor 必须一致（统一 legacy，禁 modern 引用）
 *   25. PDF virtualizer 不允许以无效极小页高建立永久 measurement（baseDims 门 + measure 重算）
 *
 * 运行：pnpm test:artifact-gate（esbuild bundle → node）
 * 退出码：全部硬规则 PASS = 0；任一 FAIL = 1。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** 仓库根：从 cwd 向上找含 package.json 的目录（bundle 后 __dirname 不可靠） */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根（package.json）");
    dir = parent;
  }
}
const ROOT = findRoot(process.cwd());

const results: Array<{ rule: string; pass: boolean; detail: string }> = [];

function check(rule: string, pass: boolean, detail = ""): void {
  results.push({ rule, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${rule}${detail ? `  — ${detail}` : ""}`);
}

/** 剔除行注释与块注释（状态机；字符串内注释不处理——gate 用途足够） */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 递归收集相对 ROOT 的文件（仅 .ts/.tsx/.mjs/.cjs），可排除目录 */
function collectFiles(dir: string, ext: RegExp, exclude: string[] = []): string[] {
  const found: string[] = [];
  const entries = existsSync(dir) ? (readdirSafe(dir) ?? []) : [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (exclude.includes(entry)) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      stat = null;
    }
    if (!stat) continue;
    if (stat.isDirectory()) {
      found.push(...collectFiles(full, ext, exclude));
    } else if (ext.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------- R1：rememberTaskArtifact 生产引用 ----------
{
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/, ["assets"]);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf-8"));
    if (/\brememberTaskArtifact\b/.test(code)) {
      hits.push(relative(ROOT, f).replace(/\\/g, "/"));
    }
  }
  check(
    "R1 rememberTaskArtifact 生产引用 = 0",
    hits.length === 0,
    hits.length > 0 ? hits.join(", ") : "src 全树无引用（仅测试构造旧数据允许）",
  );
}

// ---------- R2：renderer 无 task.artifacts 直接读写 ----------
{
  const dirs = ["src/renderer", "src/preload"];
  const hits: string[] = [];
  for (const d of dirs) {
    const files = collectFiles(join(ROOT, d), /\.tsx?$/);
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf-8"));
      if (/\btask\.artifacts\b/.test(code)) {
        hits.push(relative(ROOT, f).replace(/\\/g, "/"));
      }
    }
  }
  check(
    "R2 renderer 无 task.artifacts 直接读写 = 0",
    hits.length === 0,
    hits.length > 0 ? hits.join(", ") : "renderer/preload 无 task.artifacts 字段访问",
  );
}

// ---------- R3：ArtifactPreviewRequest.content 不存在 ----------
{
  const file = join(ROOT, "src", "shared", "agent-ipc.ts");
  const src = readFileSync(file, "utf-8");
  const marker = "export interface ArtifactPreviewRequest {";
  const start = src.indexOf(marker);
  let pass = true;
  let detail = "interface 未找到";
  if (start >= 0) {
    // 大括号配对截取 interface 体（marker 以 `{` 结尾，深度从 1 起算）
    let depth = 1;
    let i = start + marker.length;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = stripComments(src.slice(start, i + 1));
    const hasContent = /(^|\s)content\??\s*:/.test(body);
    pass = !hasContent;
    detail = hasContent
      ? "ArtifactPreviewRequest 仍声明 content 字段"
      : "interface 仅含 id（content 已消灭）";
  }
  check("R3 ArtifactPreviewRequest.content = 0", pass, detail);
}

// ---------- R4：PreviewHost registry 外部访问 = 0 ----------
{
  const hostFile = join(ROOT, "src", "main", "artifact", "ArtifactPreviewHost.ts");
  const hostSrc = stripComments(readFileSync(hostFile, "utf-8"));
  const hasRegistryField = /\bregistry\b/.test(hostSrc);
  const hostHits: string[] = [];
  if (hasRegistryField) hostHits.push("ArtifactPreviewHost.ts 仍含 registry 标识符");

  // 外部调用白名单（load/navigation/lifecycle 职责，§102）
  const ALLOWED = new Set([
    "attach",
    "setSourceResolver",
    "preview",
    "load",
    "setBounds",
    "reload",
    "hide",
    "show",
    "close",
    "dispose",
    "handleRequest",
    "visible",
    "debugger", // 4C：CaptureModeController 装配（WCV CDP 能力访问器）
    "webContentsView", // 收敛 A：PageInspectionService 统一页面检查底层装配（WCV 访问器）
  ]);
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);
  const callHits: string[] = [];
  for (const f of files) {
    if (f === hostFile) continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/artifactPreviewHost\.([A-Za-z_$][\w$]*)/g)) {
      if (!ALLOWED.has(m[1])) {
        callHits.push(`${relative(ROOT, f).replace(/\\/g, "/")}.${m[1]}`);
      }
    }
  }
  const allHits = [...hostHits, ...callHits];
  check(
    "R4 PreviewHost registry 外部访问 = 0",
    allHits.length === 0,
    allHits.length > 0 ? allHits.join(", ") : "无 registry 字段，外部仅白名单成员调用",
  );
}

// ---------- R5：legacy artifact-index production writes = 0 ----------
{
  const idxFile = join(ROOT, "src", "main", "agent", "artifact-index.ts");
  const idxSrc = stripComments(readFileSync(idxFile, "utf-8"));
  const writeApi = /writeFile|writeFileSync|mkdirSync?|appendFileSync?|rmSync|unlinkSync|renameSync|copyFileSync?|createWriteStream/;
  const inFileHits = writeApi.test(idxSrc) ? ["artifact-index.ts 含写 API"] : [];

  // 全 src：写 API 调用参数含 artifact-index
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);
  const crossHits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/(writeFileSync?|appendFileSync?|mkdirSync|rmSync|unlinkSync|renameSync)\s*\([^;]*artifact-index/g)) {
      crossHits.push(`${relative(ROOT, f).replace(/\\/g, "/")}: ${m[0].slice(0, 80)}`);
    }
  }
  const allHits = [...inFileHits, ...crossHits];
  check(
    "R5 artifact-index production writes = 0",
    allHits.length === 0,
    allHits.length > 0 ? allHits.join("; ") : "artifact-index.ts 仅只读（loadTaskArtifacts migration 源）",
  );
}

// ---------- R6：旧 9223 Capture Mode 脚本不存在（§99） ----------
{
  const banned = ["cdp-min.mjs", "cdp-capture.mjs", "capture-mode-smoke.mjs"];
  const found = banned.filter((name) => existsSync(join(ROOT, "scripts", name)));
  check(
    "R6 旧 9223 Capture Mode 脚本不存在",
    found.length === 0,
    found.length > 0 ? `scripts/ 仍存在: ${found.join(", ")}` : "scripts/ 仅保留正式 wcv-cdp-spike.cjs",
  );
}

// ---------- R7：renderer 业务组件直接 setRect/show/hide = 0（§75 Wave 4A Gate） ----------
{
  const files = collectFiles(join(ROOT, "src", "renderer"), /\.tsx?$/);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(?:api|artifact)\.(setRect|hide|show)\s*\(/g)) {
      hits.push(`${relative(ROOT, f).replace(/\\/g, "/")}: ${m[0]}`);
    }
  }
  check(
    "R7 renderer 业务组件直接 setRect/show/hide = 0",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "显示意图全部经 surface.requestBounds/requestVisible/blocker（§75）",
  );
}

// ---------- R8：PreviewHost 无业务显示状态 ownership（§102/§75） ----------
{
  const hostFile = join(ROOT, "src", "main", "artifact", "ArtifactPreviewHost.ts");
  const hostSrc = stripComments(readFileSync(hostFile, "utf-8"));
  const businessState = /\b(blocker|desiredVisible)\b/i.test(hostSrc);
  check(
    "R8 PreviewHost 无 blocker/desiredVisible 业务状态",
    !businessState,
    businessState ? "PreviewHost 重新获得了显示决策状态" : "显示决策全部在 NativeSurfaceCoordinator",
  );
}

// ---------- R9：PreviewHost 无协议/资源解析职责（§17/4B） ----------
{
  const hostFile = join(ROOT, "src", "main", "artifact", "ArtifactPreviewHost.ts");
  const hostSrc = stripComments(readFileSync(hostFile, "utf-8"));
  const forbidden = /\bhandleRequest\b|\bArtifactSourceResolver\b|\brootOf\b|\bcontentOf\b|\bfilePathOf\b|\bmimeFor\b|\bresolveWithinRoot\b/;
  const hits = forbidden.exec(hostSrc);
  check(
    "R9 PreviewHost 无 handleRequest/resolver/MIME/路径解析",
    !hits,
    hits ? `命中: ${hits[0]}` : "协议与资源解析全在 ArtifactProtocol/WebArtifactRuntime",
  );
}

// ---------- R10：protocol.handle 只挂 ArtifactProtocol（§17 机器锁） ----------
{
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);
  const directHandle: string[] = [];
  const directFsInHost: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const code = stripComments(readFileSync(f, "utf-8"));
    // protocol.handle 只能在 ArtifactProtocol.register / LibraryProtocol（library 预览协议）内出现
    for (const m of code.matchAll(/protocol\.handle\(/g)) {
      if (rel !== "src/main/artifact/ArtifactProtocol.ts" && rel !== "src/main/library/LibraryProtocol.ts") directHandle.push(`${rel}:${m[0]}`);
    }
    // PreviewHost 不得直接读文件系统（fs API 只在 Runtime/Storage）
    if (rel.startsWith("src/main/artifact/") && rel.endsWith("ArtifactPreviewHost.ts")) {
      for (const m of code.matchAll(/readFileSync|readFile|existsSync|statSync|realpathSync/g)) {
        directFsInHost.push(`${rel}:${m[0]}`);
      }
    }
  }
  const allHits = [...directHandle, ...directFsInHost];
  check(
    "R10 protocol.handle 仅 ArtifactProtocol + PreviewHost 无 fs 直接读取",
    allHits.length === 0,
    allHits.length > 0 ? allHits.join("; ") : "协议注册单点（ArtifactProtocol.register），PreviewHost 无磁盘 IO",
  );
}

// ---------- R11：renderer 无 debugger/CDP 直接调用（§78/4C） ----------
{
  const files = collectFiles(join(ROOT, "src", "renderer"), /\.tsx?$/);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(debugger|sendCommand|webContents)\b/g)) {
      hits.push(`${relative(ROOT, f).replace(/\\/g, "/")}: ${m[0]}`);
    }
  }
  check(
    "R11 renderer 无 debugger/CDP 直接调用",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "CDP 只在主进程 CaptureMode 模块",
  );
}

// ---------- R12：debugger.attach/detach/sendCommand 仅 PageInspectionService（收敛 A 单点） ----------
{
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "src/main/artifact/PageInspectionService.ts") continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\bsendCommand\s*\(/g)) {
      hits.push(`${rel}: ${m[0]}`);
    }
  }
  check(
    "R12 sendCommand 仅存在于 PageInspectionService（收敛单点）",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "CDP 命令发送单点（PageInspectionService）",
  );
}

// ---------- R13：Capture Mode 不拼 Prompt Context（§81/4C） ----------
{
  const dmFiles = [
    join(ROOT, "src", "main", "artifact", "CaptureModeController.ts"),
    join(ROOT, "src", "main", "artifact", "CdpElementInspector.ts"),
  ];
  const hits: string[] = [];
  for (const f of dmFiles) {
    if (!existsSync(f)) continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(?:prompt|PromptContext|session\.prompt)\b/g)) {
      hits.push(`${basename(f)}: ${m[0]}`);
    }
  }
  check(
    "R13 Capture Mode 不拼 Prompt Context",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "MVP 只产出 SelectionDescriptor（§82 UNTRUSTED 处理在 4E）",
  );
}

// ---------- R14：SelectionDescriptor 不由 UI 组件私有长期保存（§80/4D） ----------
{
  const files = collectFiles(join(ROOT, "src", "renderer", "src", "components"), /\.tsx?$/);
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/useState\s*<\s*SelectionDescriptor|useRef\s*<\s*SelectionDescriptor|useState\s*\([^)]*SelectionDescriptor/g)) {
      hits.push(`${relative(ROOT, f).replace(/\\/g, "/")}: ${m[0]}`);
    }
  }
  check(
    "R14 UI 组件无私存 SelectionDescriptor",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "组件只读 appStore 投影（唯一 truth 在 main SelectionStore）",
  );
}

// ---------- R15：stale 判断只在 SelectionStore / selection domain（4D 机器锁） ----------
{
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);
  const hits: string[] = [];
  const allowed = new Set([
    "src/main/artifact/SelectionStore.ts",
    "src/shared/selection.ts", // 类型/常量定义（无逻辑）
  ]);
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    if (allowed.has(rel)) continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    // 只查「实现」（方法定义），调用点（selectionStore?.validateAgainst 装配）不算
    for (const m of code.matchAll(/(?<![\w.?])(?:markStale|validateAgainst)\s*\([^)]*\)\s*[:{]/g)) {
      hits.push(`${rel}: ${m[0]}`);
    }
  }
  check(
    "R15 stale 判断仅存在于 SelectionStore",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "markStale/validateAgainst 单点（SelectionStore）",
  );
}

// ---------- R16：SelectionStore 不允许引用 debugger/webContents/CDP（4D 纯数据） ----------
{
  const storeFile = join(ROOT, "src", "main", "artifact", "SelectionStore.ts");
  const code = stripComments(readFileSync(storeFile, "utf-8"));
  const forbidden = /\b(?:debugger|webContents|sendCommand|CdpElementInspector)\b/;
  const hit = forbidden.exec(code);
  check(
    "R16 SelectionStore 无 CDP 引用",
    !hit,
    hit ? `命中: ${hit[0]}` : "纯数据 store（descriptor/status/reason/timestamps）",
  );
}

// ---------- R17-R20：Prompt Context 边界（§81/§82 4E 机器锁） ----------
{
  const pcFiles = [
    join(ROOT, "src", "main", "artifact", "PromptContextService.ts"),
    join(ROOT, "src", "main", "artifact", "PromptContextSanitizer.ts"),
    join(ROOT, "src", "main", "artifact", "PromptContextFormatter.ts"),
  ];
  const files = collectFiles(join(ROOT, "src"), /\.tsx?$/);

  // R17：formatPromptContext/sanitizeArtifactContent 只在 prompt-context 模块被调用
  const r17Hits: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    if (rel.startsWith("src/main/artifact/PromptContext")) continue;
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(?:formatPromptContext|sanitizeArtifactContent)\s*\(/g)) {
      r17Hits.push(`${rel}: ${m[0]}`);
    }
  }
  check(
    "R17 Prompt Context 拼装/清洗仅在 PromptContext 模块",
    r17Hits.length === 0,
    r17Hits.length > 0 ? r17Hits.join("; ") : "format/sanitize 单点（PromptContext 模块）",
  );

  // R18：PromptContext 模块无 fs 直接读取
  const r18Hits: string[] = [];
  for (const f of pcFiles) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(?:readFileSync|readFile|existsSync|statSync|realpathSync)\s*\(/g)) {
      r18Hits.push(`${basename(f)}: ${m[0]}`);
    }
  }
  check(
    "R18 PromptContext 模块不直接 fs 读取",
    r18Hits.length === 0,
    r18Hits.length > 0 ? r18Hits.join("; ") : "内容经 Domain readContent（root 边界）",
  );

  // R19：PromptContext 模块无 debugger/CDP/webContents
  const r19Hits: string[] = [];
  for (const f of pcFiles) {
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(?:debugger|webContents|sendCommand)\b/g)) {
      r19Hits.push(`${basename(f)}: ${m[0]}`);
    }
  }
  check(
    "R19 PromptContext 模块无 CDP/debugger 引用",
    r19Hits.length === 0,
    r19Hits.length > 0 ? r19Hits.join("; ") : "纯数据/纯函数模块",
  );

  // R20：stale selection 显式处理（存在性 gate：Service 必须含 stale 分支）
  const serviceSrc = stripComments(readFileSync(join(ROOT, "src", "main", "artifact", "PromptContextService.ts"), "utf-8"));
  const hasStale = /status === "stale"|selectionUnavailableReason/.test(serviceSrc);
  check(
    "R20 stale selection 显式处理（不注入 trusted context）",
    hasStale,
    hasStale ? "stale → selectionUnavailableReason，不注入 selection" : "缺少 stale 分支",
  );
}

// ---------- R21：Binary Viewer 禁止直接读取 Artifact Domain（hotfix §19） ----------
{
  // 二进制 Viewer（PDF/DOCX/XLSX/PPTX/Image）只允许通过 props 消费 content；
  // 内容 hydration 统一走 appStore.ensureArtifactRenderPayload → renderHydration
  // → readContent IPC。Viewer 组件内出现 readContent / ArtifactDomainIpc =
  // 绕过 Domain 边界的直接读取，违反 Wave 4「Artifact Domain = unique truth」。
  // HtmlArtifactView 是 sanctioned 的 HTML/CaptureMode surface（preview/captureMode/
  // reload 生命周期通道），不在扫描范围；ArtifactPanel 的 window.api.artifact.close()
  // 是面板生命周期操作，同样不在扫描范围（只扫 readContent/Domain IPC 直读）。
  const viewerDir = join(ROOT, "src", "renderer", "src", "components", "artifact");
  const hits: string[] = [];
  const directApi: string[] = [];
  for (const f of collectFiles(viewerDir, /\.tsx?$/)) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const base = rel.split("/").pop() ?? "";
    if (base === "HtmlArtifactView.tsx") continue; // HTML 预览/CaptureMode 受权通道
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/\b(readContent|ArtifactDomainIpc)\b/g)) {
      hits.push(`${rel}: ${m[1]}`);
    }
    // 五个二进制 Viewer 本身不得触碰任何 window.api（纯 content props 消费者）
    if (/PdfViewer|DocxViewer|XlsxViewer|PptxViewer|ImageViewer/.test(base)) {
      for (const m of code.matchAll(/\bwindow\.api\b/g)) {
        directApi.push(`${rel}: ${m[0]}`);
      }
    }
  }
  check(
    "R21 Binary Viewer 禁止直接读取 Artifact Domain（readContent/ArtifactDomainIpc = 0）",
    hits.length === 0,
    hits.length > 0 ? hits.join("; ") : "hydration 统一走 appStore.ensureArtifactRenderPayload",
  );
  check(
    "R21 二进制 Viewer 无 window.api 引用（纯 props 消费者）",
    directApi.length === 0,
    directApi.length > 0 ? directApi.join("; ") : "Pdf/Docx/Xlsx/Pptx/Image Viewer 全部经 props 接内容",
  );
}

// ---------- R22：render cache 必须绑定 artifactVersion（hotfix §5.2/§8） ----------
{
  const rh = stripComments(
    readFileSync(join(ROOT, "src", "renderer", "src", "lib", "renderHydration.ts"), "utf-8"),
  );
  const ingest = stripComments(
    readFileSync(join(ROOT, "src", "renderer", "src", "lib", "artifactIngest.ts"), "utf-8"),
  );
  const versionGuard = /cached\.artifactVersion\s*===\s*descriptor\.version/.test(rh);
  check(
    "R22 render cache 绑定 artifactVersion（命中检查 = version 匹配）",
    versionGuard,
    versionGuard ? "ensure 内 cached.artifactVersion === descriptor.version" : "cache 未绑版本",
  );
  const payloadField = /artifactVersion:\s*number/.test(ingest);
  check(
    "R22 ArtifactRenderPayload 声明 artifactVersion 字段",
    payloadField,
    payloadField ? "payload.artifactVersion: number" : "payload 缺版本字段",
  );
}

// ---------- R23：missing binary content 不得当成 ready（hotfix §12） ----------
{
  const panel = stripComments(
    readFileSync(join(ROOT, "src", "renderer", "src", "components", "artifact", "ArtifactPanel.tsx"), "utf-8"),
  );
  const rh = stripComments(
    readFileSync(join(ROOT, "src", "renderer", "src", "lib", "renderHydration.ts"), "utf-8"),
  );
  const kindGate = /if\s*\(\s*!artifact\.content\s*\)/.test(panel);
  const fallbackHydrate = /!current\.content/.test(panel) && /ensureArtifactRenderPayload\(current\.id\)/.test(panel);
  check(
    "R23 ArtifactPanel 缺内容 → loading/error 门（含 code/markdown，不喂空串）",
    kindGate,
    kindGate ? "!artifact.content → loading/error" : "缺内容门",
  );
  check(
    "R23 ArtifactPanel 缺内容兜底 hydration（tab 恢复也覆盖 code）",
    fallbackHydrate,
    fallbackHydrate ? "任意 kind 缺内容 → ensureArtifactRenderPayload" : "缺兜底 hydration",
  );
  const emptyErr = /!response\?\s*\.content/.test(rh);
  check(
    "R23 renderHydration 空内容 → error（不生成 payload）",
    emptyErr,
    emptyErr ? "readContent 空响应 → setLoadState error" : "hydration 未拦空内容",
  );
}

// ---------- R24：pdfjs API / Worker build flavor 必须一致（Wave 5C toHex 根因锁） ----------
{
  // 当前策略：MyBuddy 固定 legacy flavor（Electron 37 runtime 依赖 legacy 兼容层，
  // 如 Uint8Array.prototype.toHex）。任何 modern 引用（pdfjs-dist/build/...）都禁止：
  //   - legacy main + modern worker → 真实 worker 作用域无 legacy polyfill，
  //     运行时 `n2.toHex is not a function`（生产实测）
  //   - modern main + legacy worker → 反向不一致，同样禁止
  const rendererFiles = collectFiles(join(ROOT, "src", "renderer"), /\.tsx?$/, [
    join(ROOT, "src", "renderer", "src", "types"),
  ]);
  const modernHits: string[] = [];
  for (const f of rendererFiles) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const code = stripComments(readFileSync(f, "utf-8"));
    for (const m of code.matchAll(/(?:from\s*"|import\s*\(?"|export\s*\*\s*from\s*")(pdfjs-dist\/(?!legacy\/)[^"]+)/g)) {
      modernHits.push(`${rel}: ${m[1]}`);
    }
  }
  check(
    "R24 pdfjs 主线程/worker 统一 legacy flavor（禁 modern 引用）",
    modernHits.length === 0,
    modernHits.length > 0 ? modernHits.join("; ") : "pdfRuntime/pdfWorkerEntry 全 legacy（pdf.mjs + pdf.worker.min.mjs）",
  );

  // 存在性校验：pdfRuntime 主线程 import 必须是 legacy pdf.mjs；
  // pdfWorkerEntry 必须 export legacy worker；fake-worker fallback 必须 legacy worker。
  const rt = stripComments(readFileSync(join(ROOT, "src", "renderer", "src", "lib", "pdfRuntime.ts"), "utf-8"));
  const rtOk =
    /from\s*"pdfjs-dist\/legacy\/build\/pdf\.mjs"/.test(rt) &&
    /import\("pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs"\)/.test(rt);
  check("R24 pdfRuntime: legacy main + legacy fake-worker fallback", rtOk, rtOk ? "pdf.mjs + pdf.worker.min.mjs（legacy）" : "flavor 不一致");

  const we = stripComments(readFileSync(join(ROOT, "src", "renderer", "src", "lib", "pdfWorkerEntry.ts"), "utf-8"));
  const weOk = /export\s*\*\s*from\s*"pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs"/.test(we);
  check("R24 pdfWorkerEntry: export legacy worker", weOk, weOk ? "legacy/build/pdf.worker.min.mjs" : "非 legacy worker");
}

// ---------- R25：PDF virtualizer 不允许以无效极小页高建立永久 measurement（用户手测根因锁） ----------
{
  // 根因：react-virtual 在真实 page dimensions 未返回前，以 baseDims={0,0} 算出
  // 仅 PAGE_GAP 高的假页高（~10px）建 measurement cache；getMeasurements 的 memo
  // 不依赖 estimateSize，且无 measureElement ref → 首次尺寸永不失效 → 所有页叠在
  // 顶部互相重叠（页 top = 33/43/53/63，视觉恒为最后一页）。
  //
  // 修复要求（存在性锁）：
  //   1. baseDims 就绪前 count = 0（不挂载假尺寸 slot）
  //   2. pageHeights 变化（baseDims 就绪/缩放）→ virtualizer.measure() 强制重算
  const pv = stripComments(
    readFileSync(join(ROOT, "src", "renderer", "src", "components", "artifact", "PdfViewer.tsx"), "utf-8"),
  );
  const countGate = /count:\s*baseDims\.w\s*>\s*0\s*\?\s*numPages\s*:\s*0/.test(pv);
  check(
    "R25 PdfViewer baseDims 就绪前不挂载虚拟化 slot（count = 0）",
    countGate,
    countGate ? "count: baseDims.w > 0 ? numPages : 0" : "缺 baseDims 门（假 10px 页高会建永久 cache）",
  );
  const remeasure = /virtualizer\.measure\(\)/.test(pv);
  check(
    "R25 pageHeights 变化后强制 virtualizer.measure() 重算（防旧尺寸缓存）",
    remeasure,
    remeasure ? "useEffect([pageHeights]) → virtualizer.measure()" : "缺重算触发（缩放/尺寸就绪后 slot 错位）",
  );
}

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`Artifact Machine Gate: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((r) => r.rule).join(", ")}`);
  process.exit(1);
}
console.log("OK — 旧三份真相已消灭（§64/§98）");


