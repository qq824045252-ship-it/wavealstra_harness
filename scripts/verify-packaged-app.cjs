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
 *   - a CLI gate:  node scripts/verify-packaged-app.cjs [--app-dir <win-unpacked>] [--launch]
 *   - a module used by scripts/after-pack-windows.cjs, so electron-builder refuses
 *     to produce/accept a package whose payload cannot start the subagent worker.
 */
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

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
 * Verify one packaged app directory (`.../win-unpacked`).
 * Returns `{ ok, errors: string[], facts: Record<string, unknown> }` — never throws
 * for inspectable failures, so callers can report every problem at once.
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

  const exe = fs.readdirSync(appDir).find((name) => name.toLowerCase().endsWith(".exe") && !/unins/i.test(name));
  facts.executable = exe ?? null;
  if (!exe) fail("no application executable found in " + appDir);

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
  for (const rel of ["node_modules/better-sqlite3", "node_modules/node-pty"]) {
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

/** Resolve the app dir from argv, defaulting to the accepted release build. */
function resolveAppDir(repoRoot) {
  const index = process.argv.indexOf("--app-dir");
  if (index !== -1 && process.argv[index + 1]) return path.resolve(process.argv[index + 1]);
  const candidates = (fs.existsSync(path.join(repoRoot, "release"))
    ? fs.readdirSync(path.join(repoRoot, "release")).filter((name) => name.startsWith("win-"))
    : []
  ).map((name) => path.join(repoRoot, "release", name));
  const fallback = path.join(repoRoot, "release", "win-unpacked");
  return candidates.includes(fallback) ? fallback : fallback;
}

module.exports = { verifyPackagedApp, formatReport, readAsarIndex, flattenAsarFiles, REQUIRED_UNPACKED_ENTRIES };

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, "..");
  const appDir = resolveAppDir(repoRoot);
  const result = verifyPackagedApp(appDir, { launch: process.argv.includes("--launch") });
  console.log(formatReport(appDir, result));
  process.exit(result.ok ? 0 : 1);
}
