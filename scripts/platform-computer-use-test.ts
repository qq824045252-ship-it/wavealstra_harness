import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computerUseToolCopy, computerUseUnsupportedMessage, detectComputerUseSupport,
  executableInPath, LINUX_COMPUTER_USE_TOOLS, probeLinuxComputerUseTools,
  supportsComputerUseActivityNotice, supportsComputerUseOverlay,
} from "../src/main/platform/computer-use/support";
import {
  DEFAULT_LINUX_OCR_LANGUAGES, describeLinuxOcrProvider, ocrInstallCandidates,
  ocrSearchCandidates, resolveOcrProvider,
} from "../src/main/platform/computer-use/ocr";
import { createComputerUseBackend, resetComputerUseBackends } from "../src/main/platform/computer-use/index";
import { createActivityNotice, noticeMessage, phasePresentation } from "../src/main/platform/computer-use/linux/activityNotice";
import {
  clickMask, clickStateArgs, evdevKeycode, keyChordToKeycodes,
  keyStateArgs, ydotoolFailure, YdotoolInput,
} from "../src/main/platform/computer-use/linux/ydotool";
import { applyPlatformCommandLineSwitches } from "../src/main/platform/app";
import { ComputerUseError } from "../src/main/platform/computer-use/protocol";

/**
 * Platform contracts run without a real desktop on every host. AT-SPI object
 * lifetimes and native coordinate/input transactions have separate behavior
 * suites; the real Linux GUI gate is test:computer-use-linux.
 */
const results: string[] = [];
const directories: string[] = [];
const session: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: "wayland-test", HYPRLAND_INSTANCE_SIGNATURE: "test-session" };
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn(); results.push(name); console.log(`PASS ${name}`);
}
function fakePathDir(commands: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-platform-cu-"));
  directories.push(dir);
  for (const command of commands) {
    const file = join(dir, command);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

async function main(): Promise<void> {
await check("Linux rejects absent and unsupported compositor sessions even when every executable exists", () => {
  const pathValue = fakePathDir(LINUX_COMPUTER_USE_TOOLS);
  for (const env of [{}, { WAYLAND_DISPLAY: "wayland-1" }, { DISPLAY: ":0" }]) {
    const support = detectComputerUseSupport("linux", { pathValue, env });
    assert.equal(support.backend, "linux-atspi");
    assert.equal(support.supported, false);
    assert.match(support.reason ?? "", /Hyprland/);
  }
});

await check("Hyprland session discovery requires IPC, while screenshot and clipboard remain independent", () => {
  const unsupported = detectComputerUseSupport("linux", { pathValue: "", env: session });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason ?? "", /hyprctl/);
  assert.match(computerUseUnsupportedMessage(unsupported), /pacman/);
  const pathValue = fakePathDir(["hyprctl"]);
  const support = detectComputerUseSupport("linux", { pathValue, env: session });
  assert.equal(support.supported, true);
  assert.equal(support.backend, "linux-atspi");
  assert.deepEqual(support.missingDependencies, probeLinuxComputerUseTools(pathValue).missing);
  assert.ok(support.missingDependencies.includes("grim"));
  assert.ok(support.missingDependencies.includes("ydotool"));
  assert.match(support.reason ?? "", /refreshDiagnostics/);
  assert.doesNotMatch(support.reason ?? "", /^ready/);
});

await check("installed files do not claim bus, daemon or target readiness", () => {
  const support = detectComputerUseSupport("linux", { pathValue: fakePathDir(LINUX_COMPUTER_USE_TOOLS), env: session });
  assert.equal(support.supported, true);
  assert.deepEqual(support.missingDependencies, []);
  assert.equal(support.installHint, undefined);
  assert.match(support.reason ?? "", /refreshDiagnostics/);
  const probe = probeLinuxComputerUseTools("");
  assert.deepEqual(probe.missing, [...LINUX_COMPUTER_USE_TOOLS]);
  assert.deepEqual(probe.installed, []);
});

await check("injected session discovery never poisons the real support cache", () => {
  const before = detectComputerUseSupport("linux");
  const injected = detectComputerUseSupport("linux", { pathValue: fakePathDir(["hyprctl"]), env: session });
  assert.notEqual(injected, before);
  assert.equal(detectComputerUseSupport("linux"), before);
});

await check("computer_exec exposes distinct native contracts to Linux and Windows", () => {
  const windows = computerUseToolCopy("windows");
  assert.equal(windows.label, "Windows Computer Use");
  assert.match(windows.description, /UIA/);
  const linux = computerUseToolCopy("linux");
  assert.equal(linux.label, "Computer Use（Linux）");
  assert.match(linux.description, /AT-SPI/);
  assert.match(linux.description, /Hyprland/);
  assert.match(linux.description, /boundsReliable/);
  assert.match(linux.description, /observation_id/);
  assert.doesNotMatch(linux.description, /UIA|PrintWindow|WGC|computer-use-linux/);
  assert.doesNotMatch(linux.screenshotSummary, /Windows/);
  assert.match(computerUseToolCopy("macos").description, /unsupported/);
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

await check("the window-framing overlay stays Windows-only", () => {
  assert.equal(supportsComputerUseOverlay("windows"), true);
  assert.equal(supportsComputerUseOverlay("linux"), false);
  assert.equal(supportsComputerUseOverlay("macos"), false);
});

await check("linux gets activity notices where the overlay is unavailable", () => {
  assert.equal(supportsComputerUseActivityNotice("linux"), true);
  assert.equal(supportsComputerUseActivityNotice("windows"), false);
  assert.equal(supportsComputerUseActivityNotice("macos"), false);
});

await check("OCR candidates contain no personal absolute paths", () => {
  for (const candidate of [...ocrInstallCandidates(), ...ocrSearchCandidates().filter((c): c is string => Boolean(c))]) {
    assert.doesNotMatch(candidate, /^[A-Za-z]:\\Users\\/i, `personal Windows path leaked: ${candidate}`);
    assert.doesNotMatch(candidate, /\/Users\//, `personal macOS path leaked: ${candidate}`);
    assert.doesNotMatch(candidate, /servi/i, `personal path leaked: ${candidate}`);
  }
});

await check("MYBUDDY_OCR_CLI wins over the bundled windows OCR script", () => {
  const dir = fakePathDir([]);
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

await check("factory returns a cached backend per platform", () => {
  resetComputerUseBackends();
  const linux = createComputerUseBackend("linux");
  assert.equal(linux, createComputerUseBackend("linux"), "backend should be cached per platform");
  assert.equal(linux.platform, "linux");
  assert.equal(linux.backend, "linux-atspi");

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

await check("linux platform switches force renderer accessibility and open the AT-SPI gate", () => {
  const recorded: string[] = [];
  const fakeApp = { commandLine: { appendSwitch: (name: string) => { recorded.push(name); } } };
  const previous = process.env.GNOME_ACCESSIBILITY;
  try {
    delete process.env.GNOME_ACCESSIBILITY;
    applyPlatformCommandLineSwitches(fakeApp, "linux");
    assert.deepEqual(recorded, ["force-renderer-accessibility"]);
    // Chromium 的平台 AT-SPI 桥只认 env 或 IsEnabled；Hyprland 下后者恒为 false
    assert.equal(process.env.GNOME_ACCESSIBILITY, "1");
    // 用户显式设置的值不覆盖（"0" 是关闭）
    process.env.GNOME_ACCESSIBILITY = "0";
    applyPlatformCommandLineSwitches(fakeApp, "linux");
    assert.equal(process.env.GNOME_ACCESSIBILITY, "0");
    // 其它平台 no-op
    recorded.length = 0;
    delete process.env.GNOME_ACCESSIBILITY;
    applyPlatformCommandLineSwitches(fakeApp, "windows");
    applyPlatformCommandLineSwitches(fakeApp, "macos");
    assert.deepEqual(recorded, []);
    assert.equal(process.env.GNOME_ACCESSIBILITY, undefined);
  } finally {
    if (previous === undefined) delete process.env.GNOME_ACCESSIBILITY;
    else process.env.GNOME_ACCESSIBILITY = previous;
  }
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

await check("keyChordToKeycodes normalizes platform key names and rejects unknown keys", () => {
  assert.deepEqual(keyChordToKeycodes("Ctrl"), [29]);
  assert.deepEqual(keyChordToKeycodes("ctrl+shift+t"), [29, 42, 20]);
  assert.deepEqual(keyChordToKeycodes("ControlKey+Alt+Delete"), [29, 56, 111]);
  // ArrowLeft 的平台别名 → evdev Left（105）
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
  assert.deepEqual(keyStateArgs([], true), ["key"]);
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

await check("YdotoolInput rejects missing input dependencies before any event", async () => {
  const input = new YdotoolInput({ available: () => false, guardian: {
    setHeld: async () => { throw new Error("missing input dependencies must be rejected before guardian dispatch"); },
    scroll: async () => { throw new Error("missing input dependencies must be rejected before guardian dispatch"); },
    probe: async () => undefined, shutdown: async () => undefined,
  } });
  assert.equal(input.available, false);
  await assert.rejects(() => input.setKeysHeld("Ctrl", true), (error: unknown) => {
    assert.ok(error instanceof ComputerUseError);
    assert.equal((error as ComputerUseError).code, "HOST_UNAVAILABLE");
    assert.match((error as Error).message, /ydotool/);
    return true;
  });
  // 按钮分离走同一条通道，文案要一致
  await assert.rejects(() => input.setButtonHeld("left", "down"), /ydotool/);
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

await check("ydotool failure preserves the real cause and never asserts that remote input was undone", () => {
  for (const cause of ["failed to connect socket: Connection refused", "spawn ydotool ENOENT"]) {
    const failure = ydotoolFailure(cause, ["key", "42:1"]);
    assert.equal(failure.code, "HOST_UNAVAILABLE");
    assert.ok(failure.message.includes(cause));
    assert.equal((failure.details as { executed: unknown }).executed, "unknown");
  }
});

console.log(`platform-computer-use: ${results.length} checks passed`);
}

void main().finally(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
