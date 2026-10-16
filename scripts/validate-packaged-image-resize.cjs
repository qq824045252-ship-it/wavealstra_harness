#!/usr/bin/env node
/**
 * Packaged-artifact acceptance for the Photon image-resize fix (no hot-fix).
 *
 * Proves, against the real electron-builder output:
 *   1. app.asar carries the photon loader chunk (the code pi runs);
 *   2. app.asar.unpacked/out/main carries image-resize-worker.js and
 *      photon_rs_bg.wasm, byte-identical (sha256) to the photon-node source;
 *   3. FUNCTIONAL (packaged runtime): inside the packaged Electron app, a
 *      Worker spawned from the packaged image-resize-worker.js resizes a
 *      1400x1600 incompressible PNG end-to-end. The worker internally does
 *      readFileSync(__dirname + "/photon_rs_bg.wasm") — the exact read that used
 *      to fail and silently disable resizing. This is why the probe must run as
 *      an Electron main script, not ELECTRON_RUN_AS_NODE.
 *   4. The packaged binary starts and stays alive (skipped when MyBuddy is
 *      already running, so an active user session is never disturbed).
 *
 * Usage: node scripts/validate-packaged-image-resize.cjs [--release-dir <dir>]
 */
"use strict";

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const EXPECTED_WASM_BYTES = 1881634;

function fail(message) {
  console.error("PACKAGED-VALIDATION-FAIL: " + message);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Electron GUI launches must not inherit ELECTRON_RUN_AS_NODE=1 (it makes the
// packaged binary run as plain Node and exit immediately).
function guiEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function resolveReleaseDir() {
  const flagIndex = process.argv.indexOf("--release-dir");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return path.resolve(process.argv[flagIndex + 1]);
  }
  const candidates = fs
    .readdirSync(REPO)
    .filter((name) => name === "release" || name.startsWith("release-mybuddy-"))
    .map((name) => path.join(REPO, name, "win-unpacked"))
    .filter((dir) => fs.existsSync(path.join(dir, "MyBuddy.exe")));
  if (candidates.length === 0) fail("no packaged win-unpacked/MyBuddy.exe found");
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return path.dirname(candidates[0]);
}

const releaseDir = resolveReleaseDir();
const unpacked = path.join(releaseDir, "win-unpacked");
const exe = path.join(unpacked, "MyBuddy.exe");
const asar = path.join(unpacked, "resources", "app.asar");
const unpackedMain = path.join(unpacked, "resources", "app.asar.unpacked", "out", "main");
const worker = path.join(unpackedMain, "image-resize-worker.js");
const wasm = path.join(unpackedMain, "photon_rs_bg.wasm");
const sourceWasm = path.join(
  REPO,
  "node_modules/.pnpm/@silvia-odwyer+photon-node@0.3.4/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
);

console.log("[release]", releaseDir);

// 1. asar carries the loader chunk
if (!fs.existsSync(asar)) fail("missing app.asar: " + asar);
const asarNames = fs.readFileSync(asar).toString("latin1").match(/photon_rs-[A-Za-z0-9_-]+\.js/g);
if (!asarNames || asarNames.length === 0) fail("app.asar has no photon_rs-*.js loader chunk");
const chunkName = [...new Set(asarNames)][0];
console.log("[asar] loader chunk:", chunkName);

// 2. unpacked assets present and byte-identical
for (const file of [worker, wasm]) {
  if (!fs.existsSync(file)) fail("missing packaged asset: " + file);
}
const wasmBytes = fs.statSync(wasm).size;
if (wasmBytes !== EXPECTED_WASM_BYTES) fail(`packaged wasm is ${wasmBytes} bytes, expected ${EXPECTED_WASM_BYTES}`);
const packedHash = sha256(wasm);
if (packedHash !== sha256(sourceWasm)) fail("packaged wasm differs from photon-node source");
console.log(
  "[unpacked]",
  "image-resize-worker.js =", fs.statSync(worker).size, "B; photon_rs_bg.wasm =", wasmBytes,
  "B; sha256 =", packedHash.slice(0, 16) + "...",
);

// 3. FUNCTIONAL: packaged Electron runs the packaged worker end-to-end
const probePath = path.join(os.tmpdir(), `mybuddy-packaged-resize-probe-${process.pid}.cjs`);
const probeSource = `
const { Worker } = require("worker_threads");
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const workerPath = process.env.PROBE_WORKER;
const asarWasmPath = process.env.PROBE_ASAR_WASM;
const unpackedWasmPath = process.env.PROBE_UNPACKED_WASM;

function makeNoisePng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    let seed = (y * 2654435761) >>> 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      row[1 + x * 3] = (seed >>> 24) & 0xff;
      row[2 + x * 3] = (seed >>> 16) & 0xff;
      row[3 + x * 3] = (seed >>> 8) & 0xff;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  // 3a. asar-path read of the unpacked wasm (runtime fs transparency)
  const viaAsar = fs.readFileSync(asarWasmPath);
  const direct = fs.readFileSync(unpackedWasmPath);
  if (viaAsar.length !== direct.length || !viaAsar.equals(direct)) {
    console.error("PROBE-FAIL asar-path wasm read mismatch"); process.exit(11);
  }
  console.log("PROBE asar-path wasm read OK (" + viaAsar.length + " B)");

  // 3b. packaged worker end-to-end resize
  const png = makeNoisePng(1400, 1600);
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    worker.once("message", (m) => { worker.terminate().catch(() => {}); m && m.error ? reject(new Error(m.error)) : resolve(m); });
    worker.once("error", reject);
    const bytes = new Uint8Array(png);
    worker.postMessage({ inputBytes: bytes, mimeType: "image/png", options: { maxWidth: 2000, maxHeight: 2000 } }, [bytes.buffer]);
  });
  const res = result && result.result;
  if (!res || !res.data) { console.error("PROBE-FAIL worker returned no data: " + JSON.stringify(result)); process.exit(12); }
  console.log("PROBE worker resize OK w=" + res.width + " h=" + res.height + " wasResized=" + res.wasResized + " mime=" + res.mimeType + " base64=" + res.data.length);
  process.exit(0);
})().catch((error) => { console.error("PROBE-FAIL " + (error && error.stack || error)); process.exit(13); });
`;
fs.writeFileSync(probePath, probeSource);
const probe = cp.spawnSync(exe, [probePath], {
  cwd: unpacked,
  env: {
    ...guiEnv(),
    PROBE_WORKER: worker,
    PROBE_ASAR_WASM: path.join(asar, "out", "main", "photon_rs_bg.wasm"),
    PROBE_UNPACKED_WASM: wasm,
    ELECTRON_ENABLE_LOGGING: "0",
  },
  encoding: "utf8",
  timeout: 180000,
});
const probeOut = String(probe.stdout || "").trim();
const probeErr = String(probe.stderr || "").trim();
if (probe.status !== 0) {
  fail("packaged resize probe failed (exit " + probe.status + ")\n  stdout: " + probeOut + "\n  stderr: " + probeErr);
}
for (const line of probeOut.split("\n").filter(Boolean)) console.log("[functional]", line);
fs.rmSync(probePath, { force: true });

// 4. binary starts (skip when an instance is already running)
const running = cp.spawnSync("tasklist", ["/FI", "IMAGENAME eq MyBuddy.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout || "";
if (running.includes("MyBuddy.exe")) {
  console.log("[startup] skipped: MyBuddy.exe already running (active session left untouched)");
} else {
  const child = cp.spawn(exe, [], { cwd: unpacked, detached: true, stdio: "ignore", env: guiEnv() });
  child.unref();
  const deadline = Date.now() + 20000;
  let alive = false;
  while (Date.now() < deadline) {
    const list = cp.spawnSync("tasklist", ["/FI", "IMAGENAME eq MyBuddy.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout || "";
    if (list.includes("MyBuddy.exe")) { alive = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  }
  if (!alive) fail("packaged MyBuddy.exe did not stay running");
  console.log("[startup] MyBuddy.exe started and is running");
  cp.spawnSync("taskkill", ["/IM", "MyBuddy.exe", "/F"], { encoding: "utf8" });
  console.log("[startup] launched instance terminated after check");
}

console.log("PASS packaged-image-resize-validation");
