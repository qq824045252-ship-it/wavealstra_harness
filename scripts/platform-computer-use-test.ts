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
  imageScaleFromMeta,
  joinOcrWords,
  monitorPhysicalRect,
  monitorScaleFor,
  parseMonitors,
  parseTesseractTsv,
  toControlInfo,
  toCulKey,
  toCulModifiers,
  toWindowInfo,
} from "../src/main/platform/computer-use/linux/culProtocol";
import { chunkText } from "../src/main/platform/computer-use/linux/LinuxComputerUseBackend";

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
/* 3. Overlay 支持判定（仅 Windows）                                    */
/* ------------------------------------------------------------------ */

await check("overlay is Windows-only", () => {
  assert.equal(supportsComputerUseOverlay("windows"), true);
  assert.equal(supportsComputerUseOverlay("linux"), false);
  assert.equal(supportsComputerUseOverlay("macos"), false);
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

await check("linux backend rejects pointer/key split actions with a Wayland-specific reason", async () => {
  await withCulBinary(fakeCulBinary(), async () => {
    resetComputerUseBackends();
    const backend = createComputerUseBackend("linux");
    for (const action of ["mouse_down_client", "mouse_up_client", "key_down", "key_up"] as const) {
      await assert.rejects(backend.execute({ action }), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /Linux\/Wayland/);
        assert.match(message, /click_client|key_press/);
        return true;
      });
    }
    await backend.shutdown();
    resetComputerUseBackends();
  });
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

console.log(`platform-computer-use: ${results.length} checks passed`);
}

void main();
