#!/usr/bin/env node
/**
 * Packaged-payload acceptance for the Pi subagent runtime (build gate).
 *
 * Why this exists: the subagent worker is a *separate node process* that executes
 * files from `resources/app.asar.unpacked/out/main/capabilities/subagent/**`.
 * If the payload is packed into app.asar only, or if the unpacked tree is missing
 * (truncated copy, pruned directory, interrupted pack), the app still launches and
 * chats fine — only subagents die with
 * "安装包缺少原生 Pi 子代理 Runtime，请重新构建应用".
 * Dev mode (`out/`) always has these files, so no dev test can catch it.
 *
 * This script is both:
 *   - a CLI gate:  node scripts/verify-packaged-app.cjs [--app-dir <win-unpacked|linux-unpacked>] [--launch]
 *   - a module used by scripts/after-pack.cjs (every platform), so electron-builder
 *     refuses to produce/accept a package whose payload cannot start the subagent worker.
 */
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { verifyOfficeCli } = require("./verify-officecli.cjs");

const REQUIRED_ASAR_ENTRIES = [
  "out/main/index.js",
  "out/preload/index.js",
  "package.json",
];

/** Files a child node process must be able to open from the unpacked tree. */
const REQUIRED_UNPACKED_ENTRIES = [
  "out/main/capabilities/subagent/runtime/pi-runtime.mjs",
  "out/main/capabilities/subagent/runtime/package.json",
  "out/main/capabilities/subagent/worker-launcher.mjs",
  "out/main/capabilities/subagent/vendor/context-projection.mjs",
  "out/main/capabilities/subagent/vendor/command-code.mjs",
  "out/main/capabilities/subagent/vendor/cache-request-trace.mjs",
  "out/main/agent/request-transport.mjs",
  "out/main/codemode-worker.cjs",
  "out/main/image-resize-worker.js",
  "out/main/quickjs.wasm",
  "out/main/photon_rs_bg.wasm",
];

const WORKER_RUNTIME_PACKAGE = "@wavealstra/pi-worker-runtime";

/** Minimal asar header reader (offset 8: [uint32 headerSize][uint32 jsonSize][json]). */
function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(fd, prefix, 0, 8, 0);
    const headerSize = prefix.readUInt32LE(4);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 8);
    const jsonSize = header.readUInt32LE(4);
    const json = header.toString("utf8", 8, 8 + jsonSize);
    return JSON.parse(json);
  } finally {
    fs.closeSync(fd);
  }
}

/** Flatten the asar file tree into relative POSIX paths, keeping the `unpacked` flag. */
function flattenAsarFiles(index) {
  const files = new Map();
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node?.files ?? {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (value.files) walk(value, rel);
      else files.set(rel, { size: value.size ?? 0, unpacked: value.unpacked === true });
    }
  };
  walk(index, "");
  return files;
}

function readLauncherPin(launcherPath) {
  const source = fs.readFileSync(launcherPath, "utf8");
  const match = source.match(/const EXPECTED_PI_VERSION = "([^"]+)"/);
  return match ? match[1] : null;
}

function findNode() {
  const fromPath = (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === "win32" ? "node.exe" : "node"))
    .find((candidate) => fs.existsSync(candidate));
  if (fromPath) return fromPath;
  const programFiles = process.env.ProgramFiles ?? (process.platform === "win32" ? "C:\\Program Files" : "");
  const bundled = programFiles ? path.join(programFiles, "nodejs", process.platform === "win32" ? "node.exe" : "node") : "";
  return bundled && fs.existsSync(bundled) ? bundled : null;
}

/**
 * electron-builder 的 unpacked 目录名（win-unpacked / linux-unpacked）是目标平台的可靠提示；
 * 不依赖宿主 process.platform，才能在 Linux 上校验 Windows 产物、反之亦然。
 */
function platformFromAppDir(appDir) {
  const base = path.basename(appDir).toLowerCase();
  if (base.includes("win")) return "win32";
  if (base.includes("linux")) return "linux";
  if (base.includes("mac")) return "darwin";
  return process.platform;
}

/** Electron Linux/macOS 打包目录里与产品无关的可执行文件，不能当作主程序。 */
const HELPER_EXECUTABLES = new Set([
  "chrome-sandbox",
  "chrome_crashpad_handler",
  "chrome_crashpad_handler.exe",
]);

function isExecutableFile(filePath) {
  try {
    const info = fs.statSync(filePath);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 找打包后的主程序：Windows 是 `*.exe`；Linux 是无扩展名的可执行文件
 * （`mybuddy`），需排除 chrome-sandbox / chrome_crashpad_handler / `*.so` 等。
 */
function findPackagedExecutable(appDir, platform) {
  let names;
  try {
    names = fs.readdirSync(appDir);
  } catch {
    return null;
  }
  if (platform === "win32") {
    return names.find((name) => name.toLowerCase().endsWith(".exe") && !/unins/i.test(name)) ?? null;
  }
  const candidates = names.filter(
    (name) =>
      !HELPER_EXECUTABLES.has(name) &&
      !name.includes(".") &&
      isExecutableFile(path.join(appDir, name)),
  );
  if (candidates.length <= 1) return candidates[0] ?? null;
  // 多个候选时优先产品名（electron-builder 的 productFilename/executableName 小写形态）。
  const preferred = candidates.find((name) => /^mybuddy$/i.test(name)) ?? candidates.find((name) => /mybuddy|wavealstra/i.test(name));
  return preferred ?? candidates.sort()[0];
}

/**
 * Verify one packaged app directory (`.../win-unpacked` / `.../linux-unpacked`).
 * Returns `{ ok, errors: string[], facts: Record<string, unknown> }` — never throws
 * for inspectable failures, so callers can report every problem at once.
 *
 * options.platform: 'win32' | 'linux' | 'darwin'，默认由 appDir 目录名推断。
 */
function verifyPackagedApp(appDir, options = {}) {
  const errors = [];
  const facts = {};
  const fail = (message) => errors.push(message);

  const resources = path.join(appDir, "resources");
  const asarPath = path.join(resources, "app.asar");
  const unpackedRoot = path.join(resources, "app.asar.unpacked");

  if (!fs.existsSync(appDir)) return { ok: false, errors: [`app directory not found: ${appDir}`], facts };
  if (!fs.existsSync(asarPath)) return { ok: false, errors: [`app.asar not found: ${asarPath}`], facts };

  const targetPlatform = options.platform ?? platformFromAppDir(appDir);
  facts.platform = targetPlatform;
  const office = verifyOfficeCli(resources, targetPlatform);
  errors.push(...office.errors);
  Object.assign(facts, office.facts);
  const exe = findPackagedExecutable(appDir, targetPlatform);
  facts.executable = exe ?? null;
  if (!exe) {
    fail(
      targetPlatform === "win32"
        ? "no application executable (.exe) found in " + appDir
        : `no application executable (extension-less executable) found in ${appDir} for ${targetPlatform}`,
    );
  }

  let files;
  try {
    files = flattenAsarFiles(readAsarIndex(asarPath));
  } catch (error) {
    return { ok: false, errors: [`app.asar header unreadable: ${error instanceof Error ? error.message : String(error)}`], facts };
  }
  facts.asarEntries = files.size;

  for (const rel of REQUIRED_ASAR_ENTRIES) {
    const entry = files.get(rel);
    if (!entry) fail(`app.asar is missing ${rel}`);
    else if (entry.unpacked) fail(`${rel} is marked unpacked inside app.asar; the main bundle must be packed`);
    else if (entry.size <= 0) fail(`${rel} is present but empty`);
  }

  // 1. every entry the asar index marks as unpacked must exist on disk
  const unpackedEntries = [...files.entries()].filter(([, entry]) => entry.unpacked);
  facts.unpackedEntries = unpackedEntries.length;
  const missingUnpacked = unpackedEntries
    .filter(([rel]) => !fs.existsSync(path.join(unpackedRoot, rel)))
    .map(([rel]) => rel);
  facts.missingUnpacked = missingUnpacked.length;
  if (missingUnpacked.length > 0) {
    fail(
      `${missingUnpacked.length}/${unpackedEntries.length} asar entries marked unpacked are missing from app.asar.unpacked ` +
        `(this is the incomplete-payload failure; sample: ${missingUnpacked.slice(0, 5).join(", ")})`,
    );
  }

  // 2. the subagent/worker files must exist AND be unpacked (a child node process
  //    cannot execute a file that only lives inside the asar archive)
  for (const rel of REQUIRED_UNPACKED_ENTRIES) {
    const onDisk = path.join(unpackedRoot, rel);
    const entry = files.get(rel);
    if (!entry) fail(`app.asar index has no entry for ${rel}`);
    else if (!entry.unpacked) fail(`${rel} is packed inside app.asar but must be unpacked for the subagent worker`);
    if (!fs.existsSync(onDisk)) fail(`missing unpacked file: app.asar.unpacked/${rel}`);
  }

  // 3. runtime manifest must agree with the launcher's version pin
  const launcher = path.join(unpackedRoot, "out/main/capabilities/subagent/worker-launcher.mjs");
  const runtimeManifest = path.join(unpackedRoot, "out/main/capabilities/subagent/runtime/package.json");
  const pin = fs.existsSync(launcher) ? readLauncherPin(launcher) : null;
  facts.expectedPiVersion = pin;
  if (fs.existsSync(runtimeManifest)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(runtimeManifest, "utf8"));
      facts.runtimeVersion = manifest.version;
      facts.runtimeName = manifest.name;
      if (manifest.name !== WORKER_RUNTIME_PACKAGE) fail(`runtime manifest name is ${manifest.name}, expected ${WORKER_RUNTIME_PACKAGE}`);
      if (pin && manifest.version !== pin) fail(`runtime version ${manifest.version} does not match launcher pin ${pin}`);
    } catch (error) {
      fail(`runtime manifest unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 4. functional: start the packaged subagent worker exactly as the app does
  const runtimeEntry = path.join(unpackedRoot, "out/main/capabilities/subagent/runtime/pi-runtime.mjs");
  if (fs.existsSync(launcher) && fs.existsSync(runtimeEntry)) {
    const node = findNode();
    facts.node = node;
    if (!node) {
      fail("no system node executable found; the subagent worker cannot be started on this machine");
    } else {
      // Redirect to files instead of pipes: piped stdio can be denied under confined
      // runtimes (EPERM on named pipes) and can deadlock on large output.
      const outPath = path.join(require("node:os").tmpdir(), `mybuddy-worker-probe-${process.pid}.out`);
      const errPath = path.join(require("node:os").tmpdir(), `mybuddy-worker-probe-${process.pid}.err`);
      const fdOut = fs.openSync(outPath, "w");
      const fdErr = fs.openSync(errPath, "w");
      let probe;
      try {
        probe = cp.spawnSync(node, [launcher, runtimeEntry, "--version"], {
          stdio: ["ignore", fdOut, fdErr],
          timeout: 60_000,
          windowsHide: true,
          cwd: appDir,
        });
      } finally {
        fs.closeSync(fdOut);
        fs.closeSync(fdErr);
      }
      const stdout = fs.readFileSync(outPath, "utf8");
      const stderr = fs.readFileSync(errPath, "utf8");
      fs.rmSync(outPath, { force: true });
      fs.rmSync(errPath, { force: true });
      facts.workerExitCode = probe.status;
      facts.workerVersion = stdout.trim();
      if (probe.error) {
        fail(`packaged subagent worker could not be spawned: ${probe.error.message}`);
      } else if (probe.status !== 0) {
        fail(`packaged subagent worker failed to start (exit ${probe.status}): ${stderr.trim().slice(0, 400)}`);
      } else if (pin && facts.workerVersion !== pin) {
        fail(`packaged subagent worker reported version ${JSON.stringify(facts.workerVersion)}, expected ${pin}`);
      }
    }
  }

  // 5. native modules the main process loads from the unpacked tree
  const requiredNativeModules = ["node_modules/better-sqlite3", "node_modules/node-pty"];
  if (targetPlatform === "linux") {
    // @napi-rs/keyring 在缺平台包时会在 require 期抛 "Cannot find native binding"；
    // 主进程静态 import 了 BuiltinCredentialStore，不能让它以这种状态出厂。
    requiredNativeModules.push(
      "node_modules/@napi-rs/keyring",
      "node_modules/@napi-rs/keyring-linux-x64-gnu",
    );
  }
  if (targetPlatform === "win32") {
    requiredNativeModules.push("node_modules/@napi-rs/keyring-win32-x64-msvc");
  }
  for (const rel of requiredNativeModules) {
    if (!fs.existsSync(path.join(unpackedRoot, rel))) fail(`missing unpacked native module: ${rel}`);
  }

  // 6. optional: the packaged binary must start and stay alive
  if (options.launch && exe) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = cp.spawnSync(path.join(appDir, exe), ["--version"], { encoding: "utf8", timeout: 30_000, env, cwd: appDir });
    facts.launchExitCode = run.status;
    if (run.status !== 0 && run.status !== null) {
      fail(`packaged executable failed to start (exit ${run.status}): ${String(run.stderr ?? "").trim().slice(0, 300)}`);
    }
  }

  return { ok: errors.length === 0, errors, facts };
}

function formatReport(appDir, result) {
  const lines = [];
  lines.push(`[verify-packaged] app dir: ${appDir}`);
  for (const [key, value] of Object.entries(result.facts)) lines.push(`[verify-packaged]   ${key} = ${JSON.stringify(value)}`);
  if (result.ok) {
    lines.push("[verify-packaged] PASS packaged payload can start the Pi subagent runtime");
  } else {
    for (const error of result.errors) lines.push("[verify-packaged] FAIL " + error);
  }
  return lines.join("\n");
}

/**
 * Resolve the app dir from argv, defaulting to the newest unpacked build in release/.
 * 同时接受 win-unpacked 与 linux-unpacked（取修改时间最新的那个）。
 */
function resolveAppDir(repoRoot) {
  const index = process.argv.indexOf("--app-dir");
  if (index !== -1 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  const releaseDir = path.join(repoRoot, "release");
  const candidates = (fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [])
    .filter((name) => /^(win|linux|mac)/.test(name))
    .map((name) => path.join(releaseDir, name))
    .filter((dir) => fs.existsSync(dir))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates[0]) return candidates[0];
  return path.join(releaseDir, process.platform === "linux" ? "linux-unpacked" : "win-unpacked");
}

module.exports = { verifyPackagedApp, formatReport, readAsarIndex, flattenAsarFiles, findPackagedExecutable, platformFromAppDir, REQUIRED_UNPACKED_ENTRIES };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, "..");
  const appDir = resolveAppDir(repoRoot);
  const result = verifyPackagedApp(appDir, { launch: process.argv.includes("--launch") });
  console.log(formatReport(appDir, result));
  process.exit(result.ok ? 0 : 1);
}
