/** ProfessionalToolRuntime 纯/静态回归：不启动真实 GUI / Docker。 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfessionalToolRuntimeService,
  type ProfessionalToolPlatformOps,
} from "../src/main/professional-tools/ProfessionalToolRuntime";
import {
  isPenpotIdentityHtml,
  isRetiredDesignSkill,
  isRetiredManagedProvider,
} from "../src/shared/professional-tools";
import { DESIGN_PROVIDER_MCP_IDS } from "../src/shared/mode-profile";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

// 工具根 = 用户数据目录（~/.mybuddy/tools 语义，只放 compose/配置，不内置软件）。
// 用例用临时目录代替真实用户目录，避免污染 ~/.mybuddy。
// 现行受管 runtime 只剩 penpot（compose）与 drawio-ai（npx + 端口），
// 不再有 Blender / FreeCAD / Ardot / OpenDesign 的 exe 探测夹具。
const toolsRoot = mkdtempSync(join(tmpdir(), "mybuddy-tools-"));
const runtimeDir = String.raw`C:\Users\tester\.mybuddy\runtime`;
const penpotCompose = join(toolsRoot, "penpot", "docker-compose.yaml");

function fakeHarness(options: {
  secretFailure?: boolean;
  /** `where npx` 返回的 PATH 候选（Draw.io npx 解析） */
  npxCandidates?: string[];
  /** 预置 Draw.io HTTP 已就绪（端口扫描命中身份标记） */
  seedDrawioReady?: boolean;
  /** 预置 Draw.io 端口被非本服务占用（httpStatus 200 但无身份标记） */
  seedDrawioOccupiedPorts?: number[];
} = {}) {
  const files = new Set<string>([penpotCompose]);
  const drawioOccupied = new Set<number>(options.seedDrawioOccupiedPorts ?? []);
  const npxCandidates = options.npxCandidates ?? [];
  let drawioReady = options.seedDrawioReady ?? false;
  const drawioHtml = (port: number): string =>
    `<html><head><title>Next AI Draw.io</title></head><body></body></html>`;
  const events: string[] = [];
  let penpotReady = false;
  let killCount = 0;
  let dockerStopCount = 0;
  const penpotHtml = `<html><head><title>Penpot | Full-stack design</title></head><body></body></html>`;

  const ops: ProfessionalToolPlatformOps = {
    exists: (path) => files.has(path),
    // 现行 runtime 不扫描工具根目录（Penpot 直接查 compose，Draw.io 走 npx + 端口）。
    listDirectories: () => [],
    ensureDir: (path) => events.push(`mkdir:${path}`),
    writeText: (path, _text) => {
      events.push(`write:${path}`);
    },
    readTextFile: () => null,
    spawn: (command, args) => {
      events.push(`spawn:${command}:${args.join("|")}`);
      return {
        pid: 123,
        killed: false,
        unref: () => events.push(`unref:${command}`),
        kill: () => {
          killCount += 1;
          events.push(`kill:${command}`);
          return true;
        },
      };
    },
    run: async (command, args) => {
      events.push(`run:${command}:${args.join("|")}`);
      if (command === "where" || command === "which") {
        if (args.includes("npx")) return { code: npxCandidates.length ? 0 : 1, output: npxCandidates.join("\n") };
        return { code: 1, output: "" };
      }
      if (options.secretFailure && args.includes("up")) {
        return { code: 1, output: "failed http://localhost:9001/mcp/stream?userToken=TOPSECRET" };
      }
      if (args.includes("up")) penpotReady = true;
      if (args.includes("stop")) {
        penpotReady = false;
        dockerStopCount += 1;
      }
      return { code: 0, output: "ok" };
    },
    tcpReady: async () => false,
    listListeningPids: async () => [],
    runningPidsByImageName: async () => [],
    pidExecutablePath: async () => null,
    httpReady: async (url) => (url.startsWith("http://localhost:9001") ? penpotReady : false),
    httpStatus: async (url) => {
      const m = /^http:\/\/127\.0\.0\.1:(600[2-9]|601\d|6020)$/.exec(url);
      if (!m) return 0;
      const port = Number(m[1]);
      if (drawioReady) return 200;
      if (drawioOccupied.has(port)) return 200;
      return 0;
    },
    httpGet: async (url) => {
      if (url.startsWith("http://localhost:9001")) {
        return penpotReady ? penpotHtml : null;
      }
      const m = /^http:\/\/127\.0\.0\.1:(600[2-9]|601\d|6020)$/.exec(url);
      if (!m) return null;
      const port = Number(m[1]);
      if (drawioReady) return drawioHtml(port);
      if (drawioOccupied.has(port)) return "<html><title>other service</title></html>";
      return null;
    },
    openExternal: async (url) => { events.push(`open:${url}`); },
    openInApp: async (url) => { events.push(`inapp:${url}`); },
    sleep: async () => {},
  };

  const service = new ProfessionalToolRuntimeService({
    toolsRoot,
    runtimeDir,
    readyTimeoutMs: 50,
    readyPollMs: 1,
    providerEnabled: async (providerId) => {
      events.push(`provider:${providerId}`);
      return true;
    },
    ops,
  });

  return {
    service,
    ops,
    files,
    events,
    setPenpotReady: (value: boolean) => (penpotReady = value),
    killCount: () => killCount,
    dockerStopCount: () => dockerStopCount,
  };
}

async function main(): Promise<void> {
  console.log("\n== 2. Penpot prepare lazy + open 按需 ==");
  {
    const h = fakeHarness();
    const penpot = await h.service.prepareForProvider("penpot");
    assert(penpot.ok && !penpot.status.ready, "Penpot prepare lazy ok");
    assert(
      !h.events.some((e) => e.startsWith("run:docker:") && e.includes("up|-d")),
      "Penpot prepare 不 docker compose up",
    );
    assert(!h.events.some((e) => e.startsWith("open:")), "Penpot prepare 不弹浏览器");
    const penpotOpen = await h.service.open("penpot");
    assert(penpotOpen.ok && penpotOpen.status.ready, "Penpot open => docker up + Ready + 浏览器");
    assert(h.events.some((e) => e.startsWith("run:docker:") && e.includes("up|-d")), "Penpot open 才 docker up");
    assert(h.events.includes("open:http://localhost:9001"), "Penpot start/open Ready 后系统浏览器打开 9001");
    assert(!h.events.some((e) => e.startsWith("inapp:")), "Penpot 不走应用内扩展栏浏览器");
  }

  console.log("\n== 3. Penpot owned process / docker 生命周期 ==");
  {
    const h = fakeHarness();
    await h.service.prepareForProvider("penpot");
    h.service.stopOwned();
    assert(h.dockerStopCount() === 0, "prepare penpot 不启 docker，quit 也不 stop");
    await h.service.open("penpot");
    await h.service.stop("penpot");
    assert(h.dockerStopCount() === 1, "显式 stop(penpot) 才 docker stop");
  }

  console.log("\n== 4. missing / secret redaction / safe open ==");
  {
    const h = fakeHarness();
    h.files.clear();
    const missing = await h.service.status("penpot");
    assert(missing.state === "missing" && !missing.installed, "compose 不存在 => missing");
  }
  {
    const h = fakeHarness({ secretFailure: true });
    const failedResult = await h.service.open("penpot");
    const text = JSON.stringify(failedResult);
    assert(!failedResult.ok && !text.includes("TOPSECRET"), "Penpot 启动错误会清除 userToken secret");
    assert(text.includes("<redacted>"), "secret redaction 留下明确占位符");
  }
  {
    const h = fakeHarness();
    h.setPenpotReady(true);
    const started = await h.service.start("penpot");
    assert(started.ready, "Penpot 已 Ready 时 start 直接成功");
    assert(h.events.includes("open:http://localhost:9001"), "Penpot start Ready 后自动用系统浏览器打开 9001（无 token）");
    assert(!h.events.some((e) => e.startsWith("inapp:")), "已 Ready 的 start 也不走扩展栏");
  }

  console.log("\n== 6.5 Draw.io Runtime：探测 / 生命周期 / 打开 / payload ==");
  {
    // npx 未解析 → missing（明确失败原因）
    const h = fakeHarness({});
    const status = await h.service.status("drawio-ai");
    assert(status.state === "missing" && !status.installed, "npx 未解析 => missing（detail 含安装指引）");
    assert((status.detail ?? "").includes("npx"), "missing detail 指明 npx/Node");
    const payloadNull = await h.service.drawioMcpPayload();
    assert(payloadNull === null, "npx 未解析 => payload null（不写 MCP 配置）");
  }
  {
    // npx 可解析 + 外部实例已就绪（端口扫描 + 身份标记）=> ready / 复用
    const npx = "C:\\Program Files\\nodejs\\npx.cmd";
    const h = fakeHarness({ npxCandidates: [npx], seedDrawioReady: true });
    const status = await h.service.status("drawio-ai");
    assert(status.state === "ready" && status.ready, "外部实例已就绪 => ready（复用，不重复拉起）");
    assert((status.detail ?? "").includes("6002"), "ready detail 带活动端口 6002");
    const prepared = await h.service.prepareForProvider("drawio-ai");
    assert(prepared.ok && prepared.status.ready, "外部实例场景 prepare 通过");
    const payload = await h.service.drawioMcpPayload();
    assert(payload?.command === npx && payload?.args[0] === "@next-ai-drawio/mcp-server@latest", "payload command=解析 npx / args=npm 包");
    assert(payload?.env?.PORT === "6002", "payload env.PORT=6002");
    // open → 应用内浏览器（openInApp）
    const opened = await h.service.open("drawio-ai");
    assert(opened.ok, "open 成功");
    assert(h.events.includes("inapp:http://127.0.0.1:6002"), "open 走应用内扩展栏浏览器（openInApp）");
    // stopOwned：从不自启 => 无 kill
    await h.service.stop("drawio-ai");
    assert(h.killCount() === 0, "stopOwned 恒为 no-op（进程由会话内 MCP adapter 托管）");
  }
  {
    // npx 可解析 + 无实例 => stopped（预检通过；进程由会话内 adapter 拉起）
    const h = fakeHarness({ npxCandidates: ["C:\\Program Files\\nodejs\\npx.cmd"] });
    const status = await h.service.status("drawio-ai");
    assert(status.state === "stopped" && status.installed, "未运行 => stopped（installed=true）");
    const prepared = await h.service.prepareForProvider("drawio-ai");
    assert(prepared.ok && !prepared.status.ready, "prepare：预检通过（不要求 HTTP ready，会话内首条工具调用拉起）");
    // open 在未运行时明确失败（不静默）
    const opened = await h.service.open("drawio-ai");
    assert(!opened.ok && (opened.error ?? "").includes("start_session"), "未运行时 open 明确失败并指引 start_session");
  }
  {
    // 端口被非 Draw.io 服务占用 => 明确 detail（不自欺）
    const h = fakeHarness({ npxCandidates: ["npx"], seedDrawioOccupiedPorts: [6002] });
    const status = await h.service.status("drawio-ai");
    assert(status.state === "stopped", "占用端口 => stopped");
    assert((status.detail ?? "").includes("占用"), "占用 detail 说明端口被非 Draw.io 服务占用（将自动回退）");
  }

  console.log("\n== 7. session/UI 静态强制 gate ==");
  {
    const agent = readFileSync("src/main/agent/AgentService.ts", "utf-8");
    const orchestrator = readFileSync("src/main/professional-tools/RuntimeRequirementOrchestrator.ts", "utf-8");
    const durable = readFileSync("src/main/agent/durable/DurableBotService.ts", "utf-8");
    const preparePos = durable.indexOf("request = await this.prepareRequest(request)");
    const assemblePos = durable.indexOf("await this.configureRequest(open, request)", preparePos);
    assert(
      preparePos >= 0 && assemblePos > preparePos && agent.includes("ensureReady: () => this.runtimeRequirements.ensurePresetReady(preset)"),
      "Durable 在工具/MCP 装配前强制 managed runtime gate",
    );
    assert(orchestrator.includes("if (!allowed.has(providerId))"), "orchestrator 先验证 effective MCP policy 真正放行 provider");
    assert(orchestrator.includes("if (!prepared.ok)"), "orchestrator prepare 失败会阻止 session，不 silent fallback");
    // 建会话不再对 penpot 自动 open（避免每次弹浏览器）；open 仅按需
    const createSessionSlice = agent.slice(
      agent.indexOf("private async prepareDurableTask("),
      agent.indexOf("async releaseDurableTask("),
    );
    assert(
      !createSessionSlice.includes('providerId === "penpot"') &&
        !createSessionSlice.includes(".open(providerId)"),
      "createSession 不再自动 open penpot 浏览器",
    );
  }
  {
    const chat = readFileSync("src/renderer/src/components/chat/ChatView.tsx", "utf-8");
    assert(chat.includes("setModePreset(presetId)"), "HomeHero 点击仍先选择 Mode Preset");
    assert(!chat.includes("professionalTools?.prepare"), "HomeHero 点击专业 preset 不预热 Runtime");
    assert(!chat.includes("professionalTools?.open"), "HomeHero 点击专业 preset 不 open");
    assert(!chat.includes("PENPOT_DEFAULT_OPEN_URL"), "HomeHero 不持有 Penpot open URL");
    assert(!chat.includes("setBrowserUrl"), "HomeHero 不打开扩展栏浏览器");
    assert(!chat.includes("setDraftFill"), "preset 点击仍不向输入框写 prompt");
  }
  {
    const main = readFileSync("src/main/index.ts", "utf-8");
    assert(main.includes("await shell.openExternal(url);"), "ProfessionalToolRuntime openExternal 走系统外部浏览器");
    assert(
      main.includes("openInApp: async (url)") && main.includes("BrowserIpc.openRequest, { url }"),
      "openInApp op 走应用内扩展栏浏览器（browserHost.open + 渲染层 openRequest）",
    );
    const openInAppPos = main.indexOf("openInApp: async (url)");
    const openExternalPos = main.indexOf("await shell.openExternal(url);");
    assert(
      openInAppPos >= 0 && openExternalPos >= 0,
      "index.ts 同时保留 openExternal 与 openInApp 两个独立 op",
    );
    // 主窗口：全部 http(s)（含 localhost）→ 系统浏览器；专业工具 openInApp 仍走扩展栏
    assert(
      /if \(\/\^https\?:\/i\.test\(url\)\) \{\s*void shell\.openExternal\(url\);/.test(main),
      "index.ts 主窗口 http(s) 一律 openExternal（含 localhost）",
    );
    assert(
      !main.includes("artifactPreviewHost.onLocalUrl"),
      "产物预览不再把本机链接回调进扩展栏",
    );
    const runtimeSrc = readFileSync("src/main/professional-tools/ProfessionalToolRuntime.ts", "utf-8");
    const penpotOpen = runtimeSrc.slice(
      runtimeSrc.indexOf("class PenpotRuntime"),
      runtimeSrc.indexOf("class DrawioRuntime"),
    );
    assert(
      penpotOpen.includes("this.ops.openExternal(PENPOT_DEFAULT_OPEN_URL)") &&
        !penpotOpen.includes("openInApp(PENPOT_DEFAULT_OPEN_URL)"),
      "Penpot start/open 走系统浏览器（openExternal），不走扩展栏",
    );
  }
  {
    const runtime = readFileSync("src/main/professional-tools/ProfessionalToolRuntime.ts", "utf-8");
    const shared = readFileSync("src/shared/professional-tools.ts", "utf-8");
    assert(shared.includes('PENPOT_ORIGIN = "http://localhost:9001"'), "默认 origin 为 http://localhost:9001");
    assert(shared.includes("PENPOT_DEFAULT_OPEN_URL = PENPOT_ORIGIN"), "默认 open URL 等于 origin，不擅自加路径");
    assert(shared.includes("isPenpotIdentityHtml"), "Penpot identity 走兼容 2.16 title 的探测");
    assert(
      isPenpotIdentityHtml("<html><head><title>Penpot</title></head></html>"),
      "旧版 <title>Penpot</title> 仍识别为 Ready",
    );
    assert(
      isPenpotIdentityHtml("<html><head><title>Penpot | Full-stack design</title></head></html>"),
      "2.16 <title>Penpot | Full-stack design</title> 识别为 Ready",
    );
    assert(!isPenpotIdentityHtml("<html><head><title>nginx</title></head></html>"), "无关 HTTP 200 不误判为 Penpot");
    assert(!isPenpotIdentityHtml("502 Bad Gateway"), "502 正文不误判为 Penpot");
    assert(
      /PROFESSIONAL_TOOL_PROVIDER_IDS\s*=\s*\[\s*"penpot"\s*,?\s*\]/.test(shared),
      "penpot 是唯一出厂设计专业工具",
    );
    assert(shared.includes("RETIRED_MANAGED_PROVIDER_IDS"), "已下线工具仍在退役名单（插件页受管启停不展示）");
    const sidebar = readFileSync("src/renderer/src/components/Sidebar.tsx", "utf-8");
    assert(!sidebar.includes("扩展软件"), "账户菜单已去掉扩展软件入口");
    const app = readFileSync("src/renderer/src/App.tsx", "utf-8");
    assert(!app.includes("RuntimeContextInspector"), "主界面不再挂扩展软件调试台");
    const hubPage = readFileSync("src/renderer/src/components/pages/HubPage.tsx", "utf-8");
    assert(hubPage.includes("ManagedMcpRuntimeBar"), "Penpot/Draw.io 启停在插件 MCP 卡片上");
    const chips = readFileSync("src/renderer/src/components/chat/RuntimeStatusChips.tsx", "utf-8");
    assert(chips.includes("openHubMcp"), "聊天 runtime chip 跳到插件 MCP 卡片");
    assert(isRetiredManagedProvider("blender"), "blender 不再作为受管 runtime 自动拉起");
    assert(!isRetiredDesignSkill("blender-core"), "blender 技能仍可在场景模式列出");
    assert(
      !(DESIGN_PROVIDER_MCP_IDS as readonly string[]).includes("blender"),
      "general 出厂 deny 不再把已装 blender MCP 当专用 provider 排除",
    );
  }

  console.log(`\n[professional-tools-test] ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
