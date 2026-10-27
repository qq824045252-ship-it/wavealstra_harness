import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

/**
 * 平台边界测试：Computer Use 能力探测 / OCR 候选与 provider / Overlay 支持判定。
 * 全部用「注入 platform + 注入 PATH」驱动，不依赖真实 Windows 机器、不 spawn 进程。
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

async function main(): Promise<void> {
/* ------------------------------------------------------------------ */
/* 1. Linux：unsupported + 依赖探测 + pacman 安装提示                   */
/* ------------------------------------------------------------------ */

await check("linux with empty PATH reports every Wayland dependency as missing", () => {
  const support = detectComputerUseSupport("linux", { pathValue: "" });
  assert.equal(support.platform, "linux");
  assert.equal(support.backend, "linux-wayland");
  assert.equal(support.supported, false);
  assert.deepEqual([...support.missingDependencies].sort(), [...LINUX_COMPUTER_USE_TOOLS].sort());
  assert.match(support.installHint ?? "", /pacman/);
  assert.match(support.installHint ?? "", /hyprland/);
  assert.match(support.reason ?? "", /后端尚未实现/);
});

await check("linux missingDependencies matches the PATH probe exactly", () => {
  // 装一部分，确保「已安装的不列出」
  const dir = fakePathDir(["grim", "slurp", "hyprctl"]);
  const support = detectComputerUseSupport("linux", { pathValue: dir });
  const probe = probeLinuxComputerUseTools(dir);
  assert.deepEqual(support.missingDependencies, [...probe.missing].sort());
  assert.deepEqual([...probe.installed].sort(), ["grim", "hyprctl", "slurp"]);
  assert.ok(!support.missingDependencies.includes("grim"));
  assert.ok(!support.missingDependencies.includes("slurp"));
  assert.ok(support.missingDependencies.includes("tesseract"));
  assert.ok(support.missingDependencies.includes("wtype"));
  assert.ok(support.missingDependencies.includes("ydotool"));
  // 已装的包不进安装提示
  assert.doesNotMatch(support.installHint ?? "", /\bgrim\b/);
  assert.doesNotMatch(support.installHint ?? "", /\bslurp\b/);
  assert.match(support.installHint ?? "", /tesseract/);
  assert.match(support.installHint ?? "", /ydotool/);
});

await check("linux with all dependencies still reports unsupported (backend not implemented)", () => {
  const dir = fakePathDir(LINUX_COMPUTER_USE_TOOLS);
  const support = detectComputerUseSupport("linux", { pathValue: dir });
  assert.deepEqual(support.missingDependencies, []);
  assert.equal(support.installHint, undefined);
  assert.equal(support.supported, false);
  assert.equal(support.backend, "linux-wayland");
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

await check("unsupported message carries install hint, not a bare 'Windows only'", () => {
  const linux = detectComputerUseSupport("linux", { pathValue: "" });
  const message = computerUseUnsupportedMessage(linux);
  assert.match(message, /linux/);
  assert.match(message, /pacman/);
  assert.match(message, /缺少依赖/);
  assert.doesNotMatch(message, /当前仅支持 Windows/);
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
/* 5. Linux OCR provider 描述（供后续接线，不执行）                     */
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
/* 6. Backend 工厂：每平台一个 backend，Linux/macOS 显式 unsupported      */
/* ------------------------------------------------------------------ */

await check("factory returns a cached backend per platform", () => {
  resetComputerUseBackends();
  const linux = createComputerUseBackend("linux");
  assert.equal(linux, createComputerUseBackend("linux"), "backend should be cached per platform");
  assert.equal(linux.platform, "linux");
  assert.equal(linux.backend, "linux-wayland");
  assert.equal(linux.available, false);

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

await check("linux backend status is diagnostic and execute rejects with install hint", async () => {
  resetComputerUseBackends();
  const backend = createComputerUseBackend("linux");
  const status = backend.status();
  assert.equal(status.platform, "linux");
  assert.equal(status.supported, false);
  assert.match(status.detail, /linux/);
  assert.deepEqual(status.missingDependencies, detectComputerUseSupport("linux").missingDependencies);

  await assert.rejects(backend.execute({ action: "status" }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /linux/);
    assert.doesNotMatch(message, /当前仅支持 Windows/);
    return true;
  });
  await backend.shutdown(); // no-op on Linux
  resetComputerUseBackends();
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

console.log(`platform-computer-use: ${results.length} checks passed`);
}

void main();
