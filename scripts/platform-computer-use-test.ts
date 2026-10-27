import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerUseToolCopy,
  computerUseUnsupportedMessage,
  detectComputerUseSupport,
  executableInPath,
  LINUX_COMPUTER_USE_TOOLS,
  probeLinuxComputerUseTools,
  supportsComputerUseActivityNotice,
  supportsComputerUseOverlay,
} from "../src/main/platform/computer-use/support";
import {
  DEFAULT_LINUX_OCR_LANGUAGES,
  describeLinuxOcrProvider,
  ocrInstallCandidates,
  ocrSearchCandidates,
  resolveOcrProvider,
} from "../src/main/platform/computer-use/ocr";
import {
  createComputerUseBackend,
  resetComputerUseBackends,
} from "../src/main/platform/computer-use/index";
import {
  compactWindowInfo,
  culFailureCode,
  dipPerImagePixel,
  filterWindows,
  findControl,
  controlBoundsAreZeroOrigin,
  imageScaleFromMeta,
  joinOcrWords,
  monitorPhysicalRect,
  monitorScaleFor,
  parseMonitors,
  parseTesseractTsv,
  stripUnreliableControlBounds,
  toControlInfo,
  toCulKey,
  toCulModifiers,
  toWindowInfo,
} from "../src/main/platform/computer-use/linux/culProtocol";
import { chunkText, LinuxComputerUseBackend } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";
import {
  createActivityNotice,
  noticeMessage,
  phasePresentation,
} from "../src/main/platform/computer-use/linux/activityNotice";
import {
  clickMask,
  clickStateArgs,
  evdevKeycode,
  isStaleDaemonError,
  keyChordToKeycodes,
  keyStateArgs,
  ydotoolFailure,
  YdotoolInput,
} from "../src/main/platform/computer-use/linux/ydotool";
import {
  collectAccessibilityTree,
  toAccessibilityPage,
} from "../src/main/platform/computer-use/linux/accessibilityTree";
import {
  buildMoveScript,
  buildReadGeometryScript,
  buildResizeScript,
  createHyprlandWindowControl,
  hyprlandAddressFromHandle,
  parseGeometry,
} from "../src/main/platform/computer-use/linux/hyprlandWindows";
import { ComputerUseError } from "../src/main/platform/computer-use/protocol";

/**
 * 平台边界测试：Computer Use 能力探测 / OCR 候选与 provider / Overlay 支持判定 /
 * Linux CUL 适配层纯函数（窗口 DTO、坐标缩放、按键名、AT-SPI 控件、tesseract TSV）。
 * 全部用「注入 platform + 注入 PATH + 注入 CUL 二进制」驱动，不依赖真实 Windows、
 * 不 spawn CUL（真实截图/点击在 docs/platform-capabilities.md 的手工验收里跑）。
 */

const results: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  results.push(name);
  console.log(`PASS ${name}`);
}

/** 造一个只有指定可执行文件的临时 PATH 目录。 */
function fakePathDir(commands: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-platform-cu-"));
  for (const command of commands) {
    const file = join(dir, command);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

/** 造一个假的 CUL 二进制路径（只让探测看到「存在」，不会执行它）。 */
function fakeCulBinary(): string {
  return join(fakePathDir([]), "computer-use-linux-linux-x64");
}

/** 在给定的 CUL 二进制下运行 fn，并恢复环境变量。 */
async function withCulBinary<T>(binary: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.MYBUDDY_CUL_BIN;
  try {
    if (binary === undefined) process.env.MYBUDDY_CUL_BIN = join(tmpdir(), "mybuddy-missing-cul-binary");
    else {
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o755);
      process.env.MYBUDDY_CUL_BIN = binary;
    }
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MYBUDDY_CUL_BIN;
    else process.env.MYBUDDY_CUL_BIN = previous;
  }
}

async function main(): Promise<void> {
/* ------------------------------------------------------------------ */
/* 1. Linux：CUL 后端的能力探测                                         */
/* ------------------------------------------------------------------ */

await check("linux without the CUL binary reports unsupported with a pnpm install hint", async () => {
  await withCulBinary(undefined, () => {
    const support = detectComputerUseSupport("linux", { pathValue: "", refresh: true });
    assert.equal(support.platform, "linux");
    assert.equal(support.backend, "linux-cul");
    assert.equal(support.supported, false);
    assert.ok(support.missingDependencies.includes("computer-use-linux"));
    assert.match(support.installHint ?? "", /pnpm install/);
    assert.match(support.reason ?? "", /computer-use-linux/);
  });
});

await check("linux with the CUL binary is supported and still lists missing helper tools", async () => {
  await withCulBinary(fakeCulBinary(), () => {
    const support = detectComputerUseSupport("linux", { pathValue: "", refresh: true });
    assert.equal(support.backend, "linux-cul");
    assert.equal(support.supported, true);
    // tesseract 缺失 → 有 reason 但 supported 仍为 true（只影响 ocr_window）
    assert.deepEqual([...support.missingDependencies].sort(), [...LINUX_COMPUTER_USE_TOOLS].sort());
    assert.match(support.reason ?? "", /tesseract/);
    assert.match(support.installHint ?? "", /pacman/);
  });
});

await check("linux missingDependencies matches the PATH probe exactly", async () => {
  await withCulBinary(fakeCulBinary(), () => {
    // 装一部分，确保「已安装的不列出」
    const dir = fakePathDir(["grim", "slurp", "hyprctl"]);
    const support = detectComputerUseSupport("linux", { pathValue: dir, refresh: true });
    const probe = probeLinuxComputerUseTools(dir);
    assert.deepEqual(support.missingDependencies, [...probe.missing].sort());
    assert.deepEqual([...probe.installed].sort(), ["grim", "hyprctl", "slurp"]);
    assert.ok(!support.missingDependencies.includes("grim"));
    assert.ok(support.missingDependencies.includes("tesseract"));
    assert.ok(support.missingDependencies.includes("wtype"));
    // 已装的包不进安装提示
    assert.doesNotMatch(support.installHint ?? "", /\bgrim\b/);
    assert.match(support.installHint ?? "", /tesseract/);
  });
});

await check("linux with all dependencies is supported with no reason", async () => {
  await withCulBinary(fakeCulBinary(), () => {
    const dir = fakePathDir(LINUX_COMPUTER_USE_TOOLS);
    const support = detectComputerUseSupport("linux", { pathValue: dir, refresh: true });
    assert.deepEqual(support.missingDependencies, []);
    assert.equal(support.installHint, undefined);
    assert.equal(support.supported, true);
    assert.equal(support.reason, undefined);
  });
});

await check("detection result is cached per platform; refresh recomputes", () => {
  const first = detectComputerUseSupport("linux");
  const second = detectComputerUseSupport("linux");
  assert.equal(first, second, "cached support object should be reused");
  const refreshed = detectComputerUseSupport("linux", { refresh: true });
  assert.notEqual(refreshed, first);
  assert.deepEqual(refreshed, first);
  // 注入 pathValue 时不使用/不污染缓存
  const isolated = detectComputerUseSupport("linux", { pathValue: "" });
  assert.notEqual(isolated, first);
});

await check("executableInPath only matches files in the supplied PATH entries", () => {
  const dir = fakePathDir(["ydotool"]);
  assert.equal(executableInPath("ydotool", dir), join(dir, "ydotool"));
  assert.equal(executableInPath("grim", dir), undefined);
  assert.equal(executableInPath("ydotool", ""), undefined);
});

/* ------------------------------------------------------------------ */
/* 2. Windows / macOS                                                  */
/* ------------------------------------------------------------------ */

await check("windows is supported without any PATH probing", () => {
  const support = detectComputerUseSupport("windows", { pathValue: "" });
  assert.equal(support.platform, "windows");
  assert.equal(support.backend, "windows-uia");
  assert.equal(support.supported, true);
  assert.deepEqual(support.missingDependencies, []);
  assert.equal(support.installHint, undefined);
  assert.equal(support.reason, undefined);
});

await check("macos is unsupported with a diagnostic reason", () => {
  const support = detectComputerUseSupport("macos");
  assert.equal(support.platform, "macos");
  assert.equal(support.backend, "unsupported");
  assert.equal(support.supported, false);
  assert.match(support.reason ?? "", /macOS/);
});

await check("unsupported message carries install hint, not a bare 'Windows only'", async () => {
  await withCulBinary(undefined, () => {
    const linux = detectComputerUseSupport("linux", { pathValue: "", refresh: true });
    const message = computerUseUnsupportedMessage(linux);
    assert.match(message, /linux/);
    assert.match(message, /pnpm install/);
    assert.doesNotMatch(message, /当前仅支持 Windows/);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Overlay / 活动反馈支持判定                                        */
/* ------------------------------------------------------------------ */

await check("the window-framing overlay stays Windows-only", () => {
  // Linux 上真机验证过三条路都不成立（污染截图 / 分数缩放铺不满 / indicator 无控制通道），
  // 详见 support.ts 里 supportsComputerUseOverlay 的注释。
  assert.equal(supportsComputerUseOverlay("windows"), true);
  assert.equal(supportsComputerUseOverlay("linux"), false);
  assert.equal(supportsComputerUseOverlay("macos"), false);
});

await check("linux gets activity notices where the overlay is unavailable", () => {
  assert.equal(supportsComputerUseActivityNotice("linux"), true);
  assert.equal(supportsComputerUseActivityNotice("windows"), false);
  assert.equal(supportsComputerUseActivityNotice("macos"), false);
});

/* ------------------------------------------------------------------ */
/* 4. OCR：候选路径无个人绝对路径；env 优先；provider 选择不变           */
/* ------------------------------------------------------------------ */

await check("OCR candidates contain no personal absolute paths", () => {
  for (const candidate of [...ocrInstallCandidates(), ...ocrSearchCandidates().filter((c): c is string => Boolean(c))]) {
    assert.doesNotMatch(candidate, /^[A-Za-z]:\\Users\\/i, `personal Windows path leaked: ${candidate}`);
    assert.doesNotMatch(candidate, /\/Users\//, `personal macOS path leaked: ${candidate}`);
    assert.doesNotMatch(candidate, /servi/i, `personal path leaked: ${candidate}`);
  }
});

await check("MYBUDDY_OCR_CLI wins over the bundled windows OCR script", () => {
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-ocr-cli-"));
  const cli = join(dir, "OCR_NPU_CLI.exe");
  writeFileSync(cli, "fake");
  const previousCli = process.env.MYBUDDY_OCR_CLI;
  const previousProvider = process.env.MYBUDDY_OCR_PROVIDER;
  try {
    process.env.MYBUDDY_OCR_CLI = cli;
    delete process.env.MYBUDDY_OCR_PROVIDER;
    const provider = resolveOcrProvider();
    assert.deepEqual(provider, { kind: "npu", path: cli });

    // npu 缺失 + 强制 windows → 回落打包/仓库内 windows-ocr.ps1（仓库里存在）
    delete process.env.MYBUDDY_OCR_CLI;
    process.env.MYBUDDY_OCR_PROVIDER = "windows";
    const fallback = resolveOcrProvider();
    assert.equal(fallback?.kind, "windows");
    assert.match(fallback && "script" in fallback ? fallback.script : "", /windows-ocr\.ps1$/);
  } finally {
    if (previousCli === undefined) delete process.env.MYBUDDY_OCR_CLI;
    else process.env.MYBUDDY_OCR_CLI = previousCli;
    if (previousProvider === undefined) delete process.env.MYBUDDY_OCR_PROVIDER;
    else process.env.MYBUDDY_OCR_PROVIDER = previousProvider;
  }
});

/* ------------------------------------------------------------------ */
/* 5. Linux OCR provider 描述（tesseract，TSV 由 backend 追加）          */
/* ------------------------------------------------------------------ */

await check("linux OCR descriptor exposes tesseract command, languages and install hint", () => {
  const dir = fakePathDir(["tesseract"]);
  const descriptor = describeLinuxOcrProvider(dir, "linux");
  assert.ok(descriptor);
  assert.equal(descriptor.command, "tesseract");
  assert.equal(descriptor.kind, "tesseract");
  assert.equal(descriptor.available, true);
  assert.deepEqual(descriptor.defaultLanguages, [...DEFAULT_LINUX_OCR_LANGUAGES]);
  assert.deepEqual(descriptor.buildArgs("/tmp/a.png"), ["/tmp/a.png", "stdout", "-l", "eng+chi_sim", "--psm", "6"]);
  assert.deepEqual(descriptor.buildArgs("/tmp/a.png", ["eng"]), ["/tmp/a.png", "stdout", "-l", "eng", "--psm", "6"]);
  assert.match(descriptor.installHint, /pacman/);
  assert.match(descriptor.installHint, /tesseract/);

  const missing = describeLinuxOcrProvider("", "linux");
  assert.equal(missing?.available, false);
  assert.equal(describeLinuxOcrProvider("", "windows"), undefined);
});

/* ------------------------------------------------------------------ */
/* 6. Backend 工厂                                                     */
/* ------------------------------------------------------------------ */

await check("factory returns a cached backend per platform", () => {
  resetComputerUseBackends();
  const linux = createComputerUseBackend("linux");
  assert.equal(linux, createComputerUseBackend("linux"), "backend should be cached per platform");
  assert.equal(linux.platform, "linux");
  assert.equal(linux.backend, "linux-cul");

  const windows = createComputerUseBackend("windows");
  assert.equal(windows.platform, "windows");
  assert.equal(windows.backend, "windows-uia");
  assert.equal(windows.available, true);

  const macos = createComputerUseBackend("macos");
  assert.equal(macos.platform, "macos");
  assert.equal(macos.available, false);
  assert.notEqual(windows, linux);
  resetComputerUseBackends();
});

await check("linux backend availability and status follow the CUL binary", async () => {
  resetComputerUseBackends();
  await withCulBinary(undefined, async () => {
    const backend = createComputerUseBackend("linux");
    assert.equal(backend.available, false);
    const status = backend.status();
    assert.equal(status.platform, "linux");
    assert.equal(status.backend, "linux-cul");
    assert.equal(status.supported, false);
    assert.match(status.detail, /computer-use-linux|pnpm install/);
    await backend.shutdown();
  });
  resetComputerUseBackends();
  await withCulBinary(fakeCulBinary(), async () => {
    const backend = createComputerUseBackend("linux");
    assert.equal(backend.available, true);
    const status = backend.status();
    assert.equal(status.supported, true);
    // status() 不允许 spawn doctor：只读文件存在性 + 缓存
    assert.match(status.detail, /linux-cul/);
    assert.match(status.detail, /computer-use-linux MCP/);
    await backend.shutdown();
  });
  resetComputerUseBackends();
});

await check("linux backend implements pointer/key split through the injected ydotool runner", async () => {
  const calls: string[][] = [];
  const backend = new LinuxComputerUseBackend({
    ydotoolRunner: async (args) => { calls.push([...args]); },
    pasteViaClipboard: async () => { throw new Error("clipboard unavailable"); },
  });
  // 不带坐标/目标时不需要 CUL，纯 ydotool 写入
  await backend.execute({ action: "mouse_down_client", button: "left" });
  await backend.execute({ action: "mouse_up_client", button: "left" });
  await backend.execute({ action: "mouse_down_client", button: "right" });
  await backend.execute({ action: "key_down", key: "Ctrl" });
  await backend.execute({ action: "key_up", key: "Ctrl" });
  assert.deepEqual(calls, [
    ["click", "0x40"],
    ["click", "0x80"],
    ["click", "0x41"],
    ["key", "29:1"],
    ["key", "29:0"],
  ]);
  await backend.shutdown();
});

await check("linux backend surfaces a pacman hint when ydotool is missing", async () => {
  const backend = new LinuxComputerUseBackend({ ydotoolRunner: undefined });
  // 直接判 YdotoolInput 的不可用分支：把 PATH 清空后再调用
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      () => backend.execute({ action: "key_down", key: "Ctrl" }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /pacman -S --needed ydotool/);
        return true;
      },
    );
  } finally {
    process.env.PATH = previous;
    await backend.shutdown();
  }
});

await check("linux backend rejects modifiers/hold_ms on move_client instead of silently ignoring them", async () => {
  const calls: string[][] = [];
  const backend = new LinuxComputerUseBackend({ ydotoolRunner: async (args) => { calls.push([...args]); } });
  await assert.rejects(
    () => backend.execute({ action: "move_client", x: 10, y: 10, modifiers: ["ctrl"] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /move_client 不接受 modifiers\/hold_ms/);
      assert.match(message, /mouse_down_client/);
      return true;
    },
  );
  // 报错前不能留下按住的修饰键
  assert.deepEqual(calls, []);
  await backend.shutdown();
});

await check("windows backend exposes the UIA status contract without touching the host", () => {
  resetComputerUseBackends();
  const backend = createComputerUseBackend("windows");
  const status = backend.status();
  assert.equal(status.platform, "windows");
  assert.equal(status.backend, "windows-uia");
  assert.equal(status.supported, true);
  assert.deepEqual(status.missingDependencies, []);
  assert.match(status.detail, /windows-uia/);
  resetComputerUseBackends();
});

await check("macos backend rejects with a macOS-specific reason", async () => {
  resetComputerUseBackends();
  const backend = createComputerUseBackend("macos");
  assert.equal(backend.status().backend, "unsupported");
  await assert.rejects(backend.execute({ action: "status" }), /macOS/);
  await backend.shutdown();
  resetComputerUseBackends();
});

/* ------------------------------------------------------------------ */
/* 7. computer_exec 文案按平台区分（模型不会照着 Windows 术语调用）        */
/* ------------------------------------------------------------------ */

await check("computer_exec copy is platform specific", () => {
  const windows = computerUseToolCopy("windows");
  assert.equal(windows.label, "Windows Computer Use");
  assert.equal(windows.desktopLabel, "Windows 桌面");
  assert.match(windows.description, /UIA/);
  assert.match(windows.screenshotSummary, /Windows/);

  const linux = computerUseToolCopy("linux");
  assert.equal(linux.label, "Computer Use（Linux）");
  assert.equal(linux.desktopLabel, "Linux 桌面");
  assert.match(linux.description, /computer-use-linux/);
  assert.match(linux.description, /tesseract/);
  assert.match(linux.description, /AT-SPI/);
  assert.doesNotMatch(linux.description, /UIA|PrintWindow|WGC/);
  assert.doesNotMatch(linux.screenshotSummary, /Windows/);
  assert.doesNotMatch(linux.visionPrompt, /Windows/);

  const macos = computerUseToolCopy("macos");
  assert.match(macos.description, /unsupported/);
});

/* ------------------------------------------------------------------ */
/* 8. CUL 适配层：显示器与坐标                                          */
/* ------------------------------------------------------------------ */

const singleMonitor = parseMonitors([{ name: "eDP-1", x: 0, y: 0, width: 2160, height: 1440, scale: 1.6 }]);
const dualMonitor = parseMonitors([
  { name: "eDP-1", x: 0, y: 0, width: 2160, height: 1440, scale: 1.6 },
  { name: "DP-1", x: 1350, y: 0, width: 1280, height: 1024, scale: 1 },
]);

await check("parseMonitors normalizes scale and drops unusable entries", () => {
  assert.equal(singleMonitor.length, 1);
  assert.equal(singleMonitor[0].scale, 1.6);
  const mixed = parseMonitors([{ name: "bad", x: 0, y: 0, width: 0, height: 0, scale: 0 }, { name: "ok", x: 0, y: 0, width: 100, height: 100, scale: "2" }]);
  assert.deepEqual(mixed.map((monitor) => monitor.name), ["ok"]);
  assert.equal(mixed[0].scale, 2);
  assert.deepEqual(parseMonitors(undefined), []);
  assert.deepEqual(monitorPhysicalRect(singleMonitor[0]), { left: 0, top: 0, right: 2160, bottom: 1440, width: 2160, height: 1440 });
});

await check("monitorScaleFor picks the display under the window center", () => {
  const onLeft = monitorScaleFor({ left: 0, top: 0, width: 1000, height: 800 }, dualMonitor);
  const onRight = monitorScaleFor({ left: 2200, top: 0, width: 400, height: 300 }, dualMonitor);
  assert.equal(onLeft, 1.6);
  assert.equal(onRight, 1);
  // 命不中 → 回落原点屏；没有显示器 → 1
  assert.equal(monitorScaleFor({ left: 99_999, top: 99_999, width: 1, height: 1 }, dualMonitor), 1.6);
  assert.equal(monitorScaleFor({ left: 0, top: 0, width: 1, height: 1 }, []), 1);
});

await check("toWindowInfo maps Hyprland physical bounds and declares client = window", () => {
  const window = toWindowInfo({
    window_id: 42,
    title: "DSH Shell",
    app_id: "dsh-shell",
    wm_class: "dsh-shell",
    pid: 1234,
    bounds: { x: 19, y: 57, width: 2122, height: 1364 },
    focused: true,
  }, singleMonitor);
  assert.equal(window.handle, "42");
  assert.equal(window.processId, 1234);
  assert.equal(window.title, "DSH Shell");
  assert.equal(window.processName, "dsh-shell");
  assert.equal(window.foreground, true);
  assert.equal(window.visible, true);
  assert.equal(window.scaleFactor, 1.6);
  assert.equal(window.dpi, 154);
  assert.deepEqual(window.windowRect, { left: 19, top: 57, right: 2141, bottom: 1421, width: 2122, height: 1364 });
  assert.deepEqual(window.clientOrigin, { x: 19, y: 57 });
  assert.deepEqual(window.clientRect, { x: 0, y: 0, width: 2122, height: 1364 });

  const hidden = toWindowInfo({ window_id: 7, title: "hidden", hidden: true });
  assert.equal(hidden.visible, false);
  assert.equal(hidden.foreground, false);
  assert.equal(hidden.scaleFactor, 1);
});

await check("compactWindowInfo keeps the geometry needed for click_client", () => {
  const full = toWindowInfo({ window_id: 1, title: "t", pid: 2, bounds: { x: 10, y: 20, width: 300, height: 200 } }, singleMonitor);
  const compact = compactWindowInfo(full);
  for (const key of ["handle", "windowRect", "clientRect", "clientOrigin", "scaleFactor"] as const) {
    assert.deepEqual(compact[key], full[key], `compact lost ${key}`);
  }
});

await check("filterWindows matches title/class/process/pid case-insensitively", () => {
  const windows = [
    toWindowInfo({ window_id: 1, title: "DSH Shell · 已连接", app_id: "dsh-shell", pid: 10 }),
    toWindowInfo({ window_id: 2, title: "Firefox", app_id: "firefox", pid: 20 }),
  ];
  assert.equal(filterWindows(windows, {}).length, 2);
  assert.deepEqual(filterWindows(windows, { windowTitle: "dsh" }).map((window) => window.handle), ["1"]);
  assert.deepEqual(filterWindows(windows, { className: "firefox" }).map((window) => window.handle), ["2"]);
  assert.deepEqual(filterWindows(windows, { processName: "FIRE" }).map((window) => window.handle), ["2"]);
  assert.deepEqual(filterWindows(windows, { processId: 10 }).map((window) => window.handle), ["1"]);
  assert.deepEqual(filterWindows(windows, { processId: 99 }), []);
});

await check("image scale helpers convert between physical and image pixels", () => {
  assert.equal(imageScaleFromMeta({ scale: 0.5 }), 2);
  assert.equal(imageScaleFromMeta({ scale: 0.6597549319267273 }), 1.5157);
  assert.equal(imageScaleFromMeta({}), 1);
  assert.equal(imageScaleFromMeta({ scale: 0 }), 1);
  // 图像像素 → DIP：imageScale(2) / scale(1.6) = 1.25
  assert.equal(dipPerImagePixel(2, 1.6), 1.25);
  assert.equal(dipPerImagePixel(1, 0), 1);
});

/* ------------------------------------------------------------------ */
/* 9. CUL 适配层：按键名                                               */
/* ------------------------------------------------------------------ */

await check("toCulKey normalizes Windows-style chords to CUL key names", () => {
  assert.equal(toCulKey("Enter"), "Return");
  assert.equal(toCulKey("Esc"), "Escape");
  assert.equal(toCulKey("Ctrl+Shift+T"), "Ctrl+Shift+T");
  assert.equal(toCulKey("ControlKey+Escape"), "Ctrl+Escape");
  assert.equal(toCulKey("WIN"), "Super");
  assert.equal(toCulKey("ArrowLeft"), "Left");
  assert.equal(toCulKey("PageUp"), "Page_Up");
  assert.equal(toCulKey("F5"), "F5");
  assert.equal(toCulKey("a"), "A");
  assert.equal(toCulKey("BackSpace"), "BackSpace");
  assert.throws(() => toCulKey(""), /不能为空/);
  assert.throws(() => toCulKey("🐱"), /不支持的按键/);
});

await check("toCulModifiers maps protocol modifiers", () => {
  assert.deepEqual(toCulModifiers(["ctrl", "shift"]), ["Ctrl", "Shift"]);
  assert.deepEqual(toCulModifiers(["win"]), ["Super"]);
  assert.deepEqual(toCulModifiers(), []);
});

/* ------------------------------------------------------------------ */
/* 10. CUL 适配层：AT-SPI 控件                                         */
/* ------------------------------------------------------------------ */

await check("toControlInfo converts AT-SPI nodes to client DIP + physical bounds", () => {
  const window = toWindowInfo({ window_id: 1, title: "t", pid: 2, bounds: { x: 100, y: 50, width: 800, height: 600 } }, singleMonitor);
  const control = toControlInfo({
    index: 3,
    object_ref: "app/frame/3",
    role: "push button",
    name: "保存",
    states: ["enabled", "sensitive", "focusable"],
    actions: [{ name: "click" }, { name: "press" }],
    bounds: { x: 10, y: 20, width: 100, height: 30 },
  }, window);
  assert.equal(control.runtimeId, "app/frame/3");
  assert.equal(control.automationId, "app/frame/3");
  assert.equal(control.name, "保存");
  assert.equal(control.controlType, "push button");
  assert.equal(control.frameworkId, "at-spi2");
  assert.equal(control.enabled, true);
  assert.equal(control.keyboardFocusable, true);
  assert.equal(control.hasKeyboardFocus, false);
  assert.deepEqual(control.clientBoundsDip, { x: 10, y: 20, width: 100, height: 30 });
  // 物理：窗口原点 + DIP × 1.6
  assert.deepEqual(control.screenBoundsPhysical, { left: 116, top: 82, width: 160, height: 48 });
  assert.deepEqual(control.patterns, ["click", "press"]);

  const disabled = toControlInfo({ index: 9, role: "label", states: ["disabled"] });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.name, undefined);
  assert.equal(disabled.runtimeId, "9");
});

/* GTK 的 AT-SPI bounds 原点实测恒为 (0,0)：坐标必须作废，控件身份要保留。 */
const zeroOriginNode = (index: number, role: string, name: string, width = 80, height = 30) =>
  toControlInfo({ index, object_ref: `ref-${index}`, role, name, bounds: { x: 0, y: 0, width, height } });

await check("controlBoundsAreZeroOrigin flags GTK zero-origin trees but keeps a lone root", () => {
  const gtkDialog = [
    toControlInfo({ index: 0, role: "application", name: "zenity" }),
    zeroOriginNode(1, "dialog", "CUL-E2E", 300, 251),
    zeroOriginNode(2, "button", "OK", 120, 44),
    zeroOriginNode(3, "text box", "name", 228, 34),
  ];
  assert.equal(controlBoundsAreZeroOrigin(gtkDialog), true);
  // 窗口根节点单独是 (0,0) 属正常（client 原点即 0,0），不能因此判定整棵树不可信。
  assert.equal(controlBoundsAreZeroOrigin([gtkDialog[0], zeroOriginNode(1, "dialog", "d", 300, 251)]), false);
  // 有真实原点时正常透传
  const real = [
    toControlInfo({ index: 1, object_ref: "a", role: "push button", name: "A", bounds: { x: 12, y: 40, width: 80, height: 30 } }),
    toControlInfo({ index: 2, object_ref: "b", role: "push button", name: "B", bounds: { x: 100, y: 40, width: 80, height: 30 } }),
    toControlInfo({ index: 3, object_ref: "c", role: "push button", name: "C", bounds: { x: 0, y: 0, width: 80, height: 30 } }),
  ];
  assert.equal(controlBoundsAreZeroOrigin(real), false);
  assert.deepEqual(controlBoundsAreZeroOrigin([]), false);
});

await check("stripUnreliableControlBounds drops coordinates but keeps control identity", () => {
  const controls = [zeroOriginNode(1, "button", "OK", 120, 44)];
  const [stripped] = stripUnreliableControlBounds(controls);
  assert.equal(stripped.runtimeId, "ref-1");
  assert.equal(stripped.name, "OK");
  assert.equal(stripped.controlType, "button");
  assert.equal(stripped.clientBoundsDip, undefined);
  assert.equal(stripped.screenBoundsPhysical, undefined);
  assert.equal(stripped.bounds, undefined);
  // 没有坐标的节点原样返回（同一个对象，不做无意义拷贝）
  const bare = toControlInfo({ index: 5, role: "label", name: "x" });
  assert.equal(stripUnreliableControlBounds([bare])[0], bare);
});

await check("matchesSelector / findControl honour exactName and types", () => {
  const controls = [
    toControlInfo({ index: 0, object_ref: "a", role: "frame", name: "Save" }),
    toControlInfo({ index: 1, object_ref: "b", role: "push button", name: "Save as" }),
    toControlInfo({ index: 2, object_ref: "c", role: "entry", name: "search" }),
  ];
  assert.equal(findControl(controls, { controlName: "save" })?.runtimeId, "a");
  // exactName 区分大小写：小写 save 精确匹配不到 Save
  assert.equal(findControl(controls, { controlName: "save", exactName: true }), undefined);
  assert.equal(findControl(controls, { controlName: "Save", exactName: true })?.runtimeId, "a");
  assert.equal(findControl(controls, { controlName: "Save as", exactName: true })?.runtimeId, "b");
  assert.equal(findControl(controls, { controlType: "ENTRY" })?.runtimeId, "c");
  assert.equal(findControl(controls, { controlRuntimeId: "c" })?.runtimeId, "c");
  assert.equal(findControl(controls, { automationId: "b" })?.runtimeId, "b");
  assert.equal(findControl(controls, { controlName: "nope" }), undefined);
});

/* ------------------------------------------------------------------ */
/* 11. CUL 适配层：tesseract TSV → OcrLine                             */
/* ------------------------------------------------------------------ */

const TSV_HEADER = ["level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text"].join("\t");

await check("parseTesseractTsv aggregates words into lines with scaled DIP coordinates", () => {
  const tsv = [
    TSV_HEADER,
    "1\t1\t0\t0\t0\t0\t0\t0\t400\t200\t-1\t",
    "5\t1\t1\t1\t1\t1\t10\t20\t50\t16\t95.5\tHello",
    "5\t1\t1\t1\t1\t2\t60\t20\t40\t16\t88.0\tworld",
    "5\t1\t1\t1\t2\t1\t10\t60\t30\t16\t40.0\tfoo",
    "5\t1\t2\t1\t1\t1\t300\t100\t80\t16\t99.0\tsecond-block",
  ].join("\n");
  const lines = parseTesseractTsv(tsv, { dipPerImagePixelX: 0.5 });
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, "Hello world");
  assert.equal(lines[0].x, 5);
  assert.equal(lines[0].y, 10);
  assert.equal(lines[0].width, 45);
  assert.equal(lines[0].height, 8);
  assert.equal(lines[0].score, 0.917);
  assert.equal(lines[1].text, "foo");
  assert.equal(lines[1].score, 0.4);
  assert.equal(lines[2].text, "second-block");
});

await check("joinOcrWords keeps CJK text unspaced but spaces latin words", () => {
  assert.equal(joinOcrWords(["Hello", "world"]), "Hello world");
  assert.equal(joinOcrWords(["十", "新", "建", "任", "务"]), "十新建任务");
  assert.equal(joinOcrWords(["MyBuddy", "0.1.50"]), "MyBuddy 0.1.50");
  // 中英混排：CJK 与拉丁之间要空格，避免粘连成不可搜的串
  assert.equal(joinOcrWords(["新建", "Task"]), "新建 Task");
  assert.equal(joinOcrWords(["Task", "新建"]), "Task 新建");
  // 全角标点也算 CJK，不加空格
  assert.equal(joinOcrWords(["结论", "先行", "，", "做", "成"]), "结论先行，做成");
  assert.equal(joinOcrWords([]), "");
  assert.equal(joinOcrWords(["", "a"]), "a");
});

await check("parseTesseractTsv filters by score and caps line count", () => {
  const tsv = [
    TSV_HEADER,
    "5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t30\tlow",
    "5\t1\t1\t1\t2\t1\t0\t20\t10\t10\t90\thigh",
  ].join("\n");
  assert.deepEqual(parseTesseractTsv(tsv, { dipPerImagePixelX: 1, minScore: 0.5 }).map((line) => line.text), ["high"]);
  assert.equal(parseTesseractTsv(tsv, { dipPerImagePixelX: 1, maxLines: 1 }).length, 1);
  assert.deepEqual(parseTesseractTsv("", { dipPerImagePixelX: 1 }), []);
  assert.deepEqual(parseTesseractTsv("garbage", { dipPerImagePixelX: 1 }), []);
});

/* ------------------------------------------------------------------ */
/* 12. CUL 适配层：错误归类                                            */
/* ------------------------------------------------------------------ */

await check("culFailureCode classifies CUL messages into protocol error codes", () => {
  assert.equal(culFailureCode("click", "Operation is ambiguous"), "WINDOW_AMBIGUOUS");
  assert.equal(culFailureCode("activate_window", "No window found"), "WINDOW_NOT_FOUND");
  assert.equal(culFailureCode("screenshot", "Window is hidden"), "WINDOW_NOT_VISIBLE");
  assert.equal(culFailureCode("perform_action", "No cached accessibility node matched semantic selector"), "CONTROL_NOT_FOUND");
  assert.equal(culFailureCode("activate_window", "focus was rejected"), "FOCUS_FAILED");
  assert.equal(culFailureCode("click", "point outside window"), "POINT_OUTSIDE_CLIENT");
  assert.equal(culFailureCode("screenshot", "portal denied"), "CAPTURE_FAILED");
  assert.equal(culFailureCode("weird_tool", "something odd"), "HOST_PROTOCOL_ERROR");
});

/* ------------------------------------------------------------------ */
/* 13. type_text 分块（CUL 在无法分类字段时限制 100 字符）               */
/* ------------------------------------------------------------------ */

await check("chunkText splits on word boundaries under the CUL limit", () => {
  assert.deepEqual(chunkText("short", 90), ["short"]);
  const long = "a".repeat(80) + " " + "b".repeat(80);
  const chunks = chunkText(long, 90);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), long);
  assert.ok(chunks.every((chunk) => chunk.length <= 90));
  const newline = chunkText("x".repeat(60) + "\n" + "y".repeat(60), 90);
  assert.equal(newline.length, 2);
  assert.ok(newline[0].endsWith("\n"));
  // 没有词边界时按硬切
  const hard = chunkText("z".repeat(200), 90);
  assert.deepEqual(hard.map((chunk) => chunk.length), [90, 90, 20]);
  assert.equal(hard.join(""), "z".repeat(200));
});

/* ------------------------------------------------------------------ */
/* 14. ydotool：按下/释放分离（evdev keycode + 按钮掩码）                */
/* ------------------------------------------------------------------ */

await check("evdevKeycode maps letters, digits, punctuation, modifiers and function keys", () => {
  assert.equal(evdevKeycode("A"), 30);
  assert.equal(evdevKeycode("z"), 44);
  assert.equal(evdevKeycode("Ctrl"), 29);
  assert.equal(evdevKeycode("Shift"), 42);
  assert.equal(evdevKeycode("Alt"), 56);
  assert.equal(evdevKeycode("Super"), 125);
  assert.equal(evdevKeycode("1"), 2);
  assert.equal(evdevKeycode("0"), 11);
  assert.equal(evdevKeycode("-"), 12);
  assert.equal(evdevKeycode("="), 13);
  assert.equal(evdevKeycode("Enter"), 28);
  assert.equal(evdevKeycode("Tab"), 15);
  assert.equal(evdevKeycode("Space"), 57);
  assert.equal(evdevKeycode("Escape"), 1);
  assert.equal(evdevKeycode("ArrowLeft"), 105);
  assert.equal(evdevKeycode("F1"), 59);
  assert.equal(evdevKeycode("F12"), 88);
  assert.equal(evdevKeycode("F24"), 194);
  assert.equal(evdevKeycode("XF86AudioMute"), 113);
  // 别名：下划线/连字符/空格都归一
  assert.equal(evdevKeycode("page_down"), 109);
  assert.equal(evdevKeycode("CAPS-LOCK"), 58);
  assert.equal(evdevKeycode("NotAKey"), undefined);
});

await check("keyChordToKeycodes normalizes CUL/Windows key names and rejects unknown keys", () => {
  assert.deepEqual(keyChordToKeycodes("Ctrl"), [29]);
  assert.deepEqual(keyChordToKeycodes("ctrl+shift+t"), [29, 42, 20]);
  assert.deepEqual(keyChordToKeycodes("ControlKey+Alt+Delete"), [29, 56, 111]);
  // ArrowLeft 走 toCulKey 的 Arrow 别名 → Left（105）
  assert.deepEqual(keyChordToKeycodes("ArrowLeft"), [105]);
  // 未知键必须显式报错，不能静默丢键
  assert.throws(() => keyChordToKeycodes("SomeUnknownKey"), (error: unknown) => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal((error as ComputerUseError).code, "HOST_PROTOCOL_ERROR");
    assert.match((error as Error).message, /ydotool 不认识这个键/);
    return true;
  });
});

await check("clickMask encodes ydotool down/up flags with the button number in the low bits", () => {
  assert.equal(clickMask("left", "down"), 0x40);
  assert.equal(clickMask("left", "up"), 0x80);
  assert.equal(clickMask("right", "down"), 0x41);
  assert.equal(clickMask("right", "up"), 0x81);
  assert.equal(clickMask("middle", "down"), 0x42);
  assert.equal(clickMask("middle", "up"), 0x82);
});

await check("keyStateArgs presses in order and releases in reverse", () => {
  assert.deepEqual(keyStateArgs([29, 42, 20], true), ["key", "29:1", "42:1", "20:1"]);
  assert.deepEqual(keyStateArgs([29, 42, 20], false), ["key", "20:0", "42:0", "29:0"]);
  assert.deepEqual(clickStateArgs(0x40), ["click", "0x40"]);
  assert.deepEqual(clickStateArgs(0x81), ["click", "0x81"]);
  assert.throws(() => keyStateArgs([], true), ComputerUseError);
});

await check("YdotoolInput routes down/up through the injected runner without touching the real machine", async () => {
  const calls: string[][] = [];
  const input = new YdotoolInput({ runner: async (args) => { calls.push([...args]); } });
  assert.equal(input.available, true);
  const codes = await input.setKeysHeld("Ctrl+Shift", true);
  assert.deepEqual(codes, [29, 42]);
  await input.setKeysHeld("Ctrl+Shift", false);
  await input.setButtonHeld("left", "down");
  await input.setButtonHeld("right", "up");
  assert.deepEqual(calls, [
    ["key", "29:1", "42:1"],
    ["key", "42:0", "29:0"],
    ["click", "0x40"],
    ["click", "0x81"],
  ]);
});

await check("YdotoolInput reports a pacman install hint when ydotool is missing", async () => {
  const input = new YdotoolInput({ available: () => false });
  assert.equal(input.available, false);
  await assert.rejects(() => input.setKeysHeld("Ctrl", true), (error: unknown) => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal((error as ComputerUseError).code, "HOST_UNAVAILABLE");
    assert.match((error as Error).message, /pacman -S --needed ydotool/);
    return true;
  });
  // 按钮分离走同一条通道，文案要一致
  await assert.rejects(() => input.setButtonHeld("left", "down"), /ydotool/);
});

/* ------------------------------------------------------------------ */
/* 15. AT-SPI 语义树分页（CUL get_tree_page）                           */
/* ------------------------------------------------------------------ */

function fakeNode(index: number, role = "section"): { index: number; role: string; name: string; object_ref: string } {
  return { index, role, name: `node-${index}`, object_ref: `/org/a11y/${index}` };
}

await check("collectAccessibilityTree does not page when the first screen is complete", async () => {
  const firstScreen = [fakeNode(0), fakeNode(1)];
  let fetched = 0;
  const collected = await collectAccessibilityTree(firstScreen, false, {
    fetchPage: async () => { fetched += 1; return { nodes: [], nextOffset: null }; },
  });
  assert.equal(fetched, 0);
  assert.equal(collected.nodes.length, 2);
  assert.equal(collected.pages, 1);
  assert.equal(collected.truncated, false);
});

await check("collectAccessibilityTree follows next_offset until the server ends the tree", async () => {
  // 复刻真机形状：首屏 21 个内联节点 → 后续页 next_offset 依次 41/74/105 → 末尾
  const firstScreen = Array.from({ length: 21 }, (_, index) => fakeNode(index));
  const pages = new Map<number, { nodes: unknown[]; nextOffset: number | null; totalNodes: number }>([
    [21, { nodes: [fakeNode(21), fakeNode(22)], nextOffset: 41, totalNodes: 63 }],
    [41, { nodes: [fakeNode(41), fakeNode(42)], nextOffset: 74, totalNodes: 63 }],
    [74, { nodes: [fakeNode(74)], nextOffset: null, totalNodes: 63 }],
  ]);
  const requested: number[] = [];
  const collected = await collectAccessibilityTree(firstScreen, true, {
    fetchPage: async (offset) => {
      requested.push(offset);
      const page = pages.get(offset);
      assert.ok(page, `unexpected offset ${offset}`);
      return page as never;
    },
  });
  // 关键：offset 必须用服务端给的 next_offset 推进（每页条数不固定），不能 offset+len
  assert.deepEqual(requested, [21, 41, 74]);
  assert.deepEqual(collected.nodes.map((node) => node.index), [...firstScreen.map((node) => node.index), 21, 22, 41, 42, 74]);
  assert.equal(collected.pages, 4);
  assert.equal(collected.totalNodes, 63);
  assert.equal(collected.truncated, false);
});

await check("collectAccessibilityTree paginates when spill reports more nodes than the inline screen", async () => {
  // 真机回归：CUL 把树 compact 到 ~37 个节点后仍报 truncated=false，只有
  // accessibility_tree_spill.node_count 说出「一共 71 个」。不信 spill 就会漏掉
  // 整页可交互控件（Nautilus 的 10 个 grid cell 全在第 2 页）。
  const inline = Array.from({ length: 37 }, (_, index) => fakeNode(index));
  const requested: number[] = [];
  const collected = await collectAccessibilityTree(inline, false, {
    totalNodes: 71,
    fetchPage: async (offset) => {
      requested.push(offset);
      return { nodes: Array.from({ length: 34 }, (_, index) => fakeNode(offset + index)), nextOffset: null, totalNodes: 71 };
    },
  });
  assert.deepEqual(requested, [37], "truncated=false 但有 spill 总数时必须从内联末尾翻页");
  assert.equal(collected.nodes.length, 71);
  assert.equal(collected.pages, 2);
  assert.equal(collected.truncated, false);
});

await check("collectAccessibilityTree does not page when spill total matches the inline screen", async () => {
  const inline = Array.from({ length: 5 }, (_, index) => fakeNode(index));
  let fetched = 0;
  const collected = await collectAccessibilityTree(inline, false, {
    totalNodes: 5,
    fetchPage: async () => { fetched += 1; return { nodes: [], nextOffset: null }; },
  });
  assert.equal(fetched, 0);
  assert.equal(collected.nodes.length, 5);
  assert.equal(collected.pages, 1);
});

await check("collectAccessibilityTree stops at the page and node caps and reports truncation", async () => {
  const collected = await collectAccessibilityTree([fakeNode(0)], true, {
    maxPages: 2,
    maxNodes: 4,
    fetchPage: async (offset) => ({ nodes: [fakeNode(offset), fakeNode(offset + 1), fakeNode(offset + 2)], nextOffset: offset + 10 }),
  });
  // 首屏 1 + 第一页取到 3（到 4 个上限）→ 不再翻页，truncated 必须为真
  assert.equal(collected.pages, 2);
  assert.equal(collected.nodes.length, 4);
  assert.equal(collected.truncated, true);
});

await check("collectAccessibilityTree keeps collected nodes when a later page fails", async () => {
  const collected = await collectAccessibilityTree([fakeNode(0), fakeNode(1)], true, {
    fetchPage: async () => { throw new Error("MCP socket closed"); },
  });
  assert.equal(collected.nodes.length, 2);
  assert.equal(collected.truncated, true);
});

await check("toAccessibilityPage normalizes next_offset/node_count and tolerates junk", () => {
  const page = toAccessibilityPage({ nodes: [fakeNode(0)], next_offset: 21, node_count: 63 });
  assert.equal(page.nextOffset, 21);
  assert.equal(page.totalNodes, 63);
  assert.equal(page.nodes.length, 1);
  assert.deepEqual(toAccessibilityPage({}), { nodes: [], nextOffset: null, totalNodes: undefined });
  assert.equal(toAccessibilityPage({ nodes: [], next_offset: null }).nextOffset, null);
  assert.equal(toAccessibilityPage({ nodes: [], next_offset: 0 }).nextOffset, null);
});

await check("toAccessibilityPage reflects the real 21-node inline screen from get_app_state", () => {
  // 真机：get_app_state(MyBuddy electron window) → 21 个节点，truncated，raw_count 63
  const inline = Array.from({ length: 21 }, (_, index) => fakeNode(index));
  const collected = collectAccessibilityTree(inline, true, {
    fetchPage: async (offset) => ({ nodes: [fakeNode(offset)], nextOffset: null }),
  });
  return collected.then((result) => {
    assert.equal(result.nodes.length, 22);
    assert.equal(result.truncated, false);
  });
});

await check("hyprlandAddressFromHandle converts CUL's decimal window_id to a Hyprland 0x address", () => {
  // 真机样本：CUL 的 window_id 就是 Hyprland 窗口指针的十进制。
  assert.equal(hyprlandAddressFromHandle("94718514217904"), "0x56255f64c3b0");
  assert.equal(hyprlandAddressFromHandle("0x56255F64C3B0"), "0x56255f64c3b0");
  assert.equal(hyprlandAddressFromHandle("  0x1a  "), "0x1a");
  assert.equal(hyprlandAddressFromHandle(""), undefined);
  assert.equal(hyprlandAddressFromHandle("not-a-handle"), undefined);
  assert.equal(hyprlandAddressFromHandle("-5"), undefined);
});

await check("buildMoveScript floats tiling windows first and always wraps dispatch", () => {
  const script = buildMoveScript("0x1a", 200, 150);
  // 最大的坑：只写 hl.dsp.window.move(...) 不执行，必须 hl.dispatch(...)
  assert.match(script, /hl\.dispatch\(hl\.dsp\.window\.move\(\{window = target, x = 200, y = 150\}\)\)/);
  assert.match(script, /if not target\.floating then hl\.dispatch\(hl\.dsp\.window\.float\(/);
  assert.match(script, /return "moved"/);
  assert.match(script, /hl\.get_windows\(\)/);
  assert.match(script, /0x1a/);
});

await check("buildMoveScript clamps out-of-range coordinates and rounds fractions", () => {
  const script = buildMoveScript("0x1a", 999_999, -999_999);
  assert.match(script, /x = 32000, y = -32000/);
  assert.match(buildMoveScript("0x1a", 10.6, 10.2), /x = 11, y = 10/);
});

await check("buildResizeScript clamps to a positive size", () => {
  const script = buildResizeScript("0x1a", 700, 500);
  assert.match(script, /hl\.dispatch\(hl\.dsp\.window\.resize\(\{window = target, x = 700, y = 500\}\)\)/);
  assert.match(script, /return "resized"/);
  assert.match(buildResizeScript("0x1a", 0, -20), /x = 1, y = 1/);
  assert.match(buildResizeScript("0x1a", 99_999, 99_999), /x = 32000, y = 32000/);
});

await check("parseGeometry reads the 5-field readback and rejects junk", () => {
  assert.deepEqual(parseGeometry("200,150,700,500,true"), { x: 200, y: 150, width: 700, height: 500, floating: true });
  assert.deepEqual(parseGeometry(" 12,36,652,848,false "), { x: 12, y: 36, width: 652, height: 848, floating: false });
  assert.equal(parseGeometry("missing"), undefined);
  assert.equal(parseGeometry("1,2,3"), undefined);
  assert.equal(parseGeometry("1,2,3,4,true,5"), undefined);
  assert.equal(parseGeometry("a,b,c,d,true"), undefined);
});

await check("createHyprlandWindowControl reports synthesizer-adopted geometry, not the request", async () => {
  const scripts: string[] = [];
  const control = createHyprlandWindowControl(async (args) => {
    const script = args[1] ?? "";
    scripts.push(script);
    if (script.includes('return tostring(target.at.x)')) {
      // 动作后的读回故意返回和请求不同的值：模拟合成器自己调整了窗口
      // （平铺→浮窗、吸附等），调用方必须看到真实值而不是请求值。
      return "201,151,700,500,true";
    }
    return "moved";
  });
  const rect = await control.move("94718514217904", 200, 150);
  assert.deepEqual(rect, { x: 201, y: 151, width: 700, height: 500, floating: true });
  assert.equal(scripts.length, 2, "应该先下发动作再读回几何");
  assert.match(scripts[0], /hl\.dispatch\(hl\.dsp\.window\.move/);
  assert.match(scripts[1], /return tostring\(target\.at\.x\)/);
});

await check("createHyprlandWindowControl maps a missing window to WINDOW_NOT_FOUND", async () => {
  const control = createHyprlandWindowControl(async () => "missing");
  await assert.rejects(
    () => control.move("0x1a", 10, 10),
    (error: unknown) => {
      assert.ok(error instanceof ComputerUseError);
      assert.equal(error.code, "WINDOW_NOT_FOUND");
      return true;
    },
  );
});

await check("createHyprlandWindowControl distinguishes a missing hyprctl from a Lua failure", async () => {
  const unavailable = createHyprlandWindowControl(async () => {
    throw new Error("command not found: hyprctl");
  });
  await assert.rejects(
    () => unavailable.move("0x1a", 10, 10),
    (error: unknown) => {
      assert.ok(error instanceof ComputerUseError);
      assert.equal(error.code, "HOST_UNAVAILABLE");
      assert.match(error.message, /hyprctl 不可用/);
      return true;
    },
  );
  const broken = createHyprlandWindowControl(async () => {
    throw new Error("lua: attempt to index a nil value");
  });
  await assert.rejects(
    () => broken.move("0x1a", 10, 10),
    (error: unknown) => {
      assert.ok(error instanceof ComputerUseError);
      assert.equal(error.code, "HOST_PROTOCOL_ERROR");
      assert.match(error.message, /hyprctl repl 失败/);
      return true;
    },
  );
});

await check("linux backend rejects move_window/resize_window without coordinates before touching the desktop", async () => {
  let replCalls = 0;
  const backend = new LinuxComputerUseBackend({
    windowControl: createHyprlandWindowControl(async () => {
      replCalls += 1;
      return "moved";
    }),
  });
  await assert.rejects(
    () => backend.execute({ action: "move_window", windowHandle: "0x1a" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /window_x 与 window_y/);
      return true;
    },
  );
  await assert.rejects(
    () => backend.execute({ action: "resize_window", windowHandle: "0x1a" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /window_width 与 window_height/);
      return true;
    },
  );
  assert.equal(replCalls, 0, "参数校验失败时不该下发 hyprctl 命令");
  await backend.shutdown();
});

await check("phasePresentation maps every phase to a distinct hyprctl notify colour", () => {
  const phases = ["observing", "acting", "verifying", "waiting", "recovering", "completed", "failed"] as const;
  const seen = new Set<string>();
  for (const phase of phases) {
    const presentation = phasePresentation(phase);
    assert.match(presentation.color, /^rgb\(\d+,\d+,\d+\)$/, `${phase} 的颜色格式不对`);
    assert.ok(presentation.durationMs > 0, `${phase} 的停留时间必须 > 0`);
    assert.ok(presentation.label.length > 0);
    seen.add(presentation.color);
  }
  // 成功/失败必须能靠颜色区分开，否则用户看不出结果。
  assert.notEqual(phasePresentation("completed").color, phasePresentation("failed").color);
});

await check("noticeMessage prefixes MyBuddy and truncates long targets", () => {
  assert.equal(noticeMessage("acting"), "MyBuddy · 正在操作");
  assert.equal(noticeMessage("acting", "  "), "MyBuddy · 正在操作");
  assert.equal(noticeMessage("verifying", "Nautilus"), "MyBuddy · 验证结果 · Nautilus");
  const long = "x".repeat(200);
  const message = noticeMessage("observing", long);
  assert.ok(message.length < 70, `通知太长会被通知栏截断：${message.length}`);
  assert.match(message, /…$/);
});

await check("activity notice sends hyprctl notify and never throws when hyprctl is missing", async () => {
  const calls: string[][] = [];
  const notice = createActivityNotice({ runner: async (args) => { calls.push([...args]); } });
  assert.equal(notice.available, true);
  notice.show("acting", "Nautilus");
  // show() 是 fire-and-forget；等一个微任务让 runner 被调用。
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["notify", "1", "4000"]);
  assert.equal(calls[0][3], "rgb(91,141,255)");
  assert.equal(calls[0][4], "MyBuddy · 正在操作 · Nautilus");

  // hyprctl 不存在时必须静默降级，不能把 Computer Use 打断。
  const failing = createActivityNotice({ runner: async () => { throw new Error("command not found: hyprctl"); } });
  failing.show("failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

await check("activity notice is a no-op when disabled", async () => {
  const calls: string[][] = [];
  const notice = createActivityNotice({ available: false, runner: async (args) => { calls.push([...args]); } });
  assert.equal(notice.available, false);
  notice.show("acting");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
});

await check("isStaleDaemonError tells a dead ydotoold apart from a missing ydotool", () => {
  // 实测踩过：ydotoold 的 start-limit-hit 之后 socket 文件残留，ydotool 报
  // "Connection refused"/"Please check if ydotoold is running."，与「没装」很难区分。
  assert.equal(isStaleDaemonError("failed to connect socket `/run/user/1000/.ydotool_socket': Connection refused"), true);
  assert.equal(isStaleDaemonError("Please check if ydotoold is running."), true);
  assert.equal(isStaleDaemonError("failed to connect socket"), true);
  assert.equal(isStaleDaemonError("spawn ydotool ENOENT"), false);
  assert.equal(isStaleDaemonError("ydotool: unrecognized option"), false);
});

await check("ydotoolFailure gives an actionable recovery command for a dead daemon", () => {
  const dead = ydotoolFailure("failed to connect socket: Connection refused", ["key", "42:1"]);
  assert.equal(dead.code, "HOST_UNAVAILABLE");
  assert.match(dead.message, /rm -f \/run\/user/);
  assert.match(dead.message, /systemctl --user reset-failed ydotool/);
  assert.match(dead.message, /systemctl --user restart ydotool/);
  const missing = ydotoolFailure("spawn ydotool ENOENT", ["key", "42:1"]);
  assert.equal(missing.code, "HOST_UNAVAILABLE");
  assert.match(missing.message, /ydotool 执行失败：spawn ydotool ENOENT/);
  // 不要把「没装」也误导成「重启服务」。
  assert.doesNotMatch(missing.message, /reset-failed/);
});

console.log(`platform-computer-use: ${results.length} checks passed`);
}

void main();
