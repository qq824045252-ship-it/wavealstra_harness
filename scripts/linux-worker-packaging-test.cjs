"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyLinuxWorkerRuntime, verifyInputGuardianRuntime, nodeVersionAtLeast } = require("./verify-packaged-app.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mybuddy-linux-payload-"));
const appDir = path.join(root, "linux-unpacked");
const unpacked = path.join(appDir, "resources/app.asar.unpacked");
const worker = path.join(unpacked, "out/main/atspi-worker.cjs");
const manifestPath = path.join(unpacked, "out/main/linux-computer-use-runtime.json");
const appManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const pinned = appManifest.dependencies["dbus-native"];
const manifest = {
  protocol: 1, backend: "linux-atspi", worker: "atspi-worker.cjs", inputGuardian: "input-guardian.cjs",
  minimumNodeVersion: "24.0.0", dbusNativeVersion: pinned,
};
const good = {
  protocol: 1, backend: "linux-atspi", nodeVersion: "24.1.0",
  dbusNativeVersion: pinned, pid: 123, ready: true,
};
const results = [];
const check = (name, fn) => { fn(); results.push(name); console.log(`PASS ${name}`); };
const probe = (handshake, exit = 0) => verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, {
  spawnSync: () => ({ status: exit, stdout: JSON.stringify(handshake), stderr: "" }),
});

try {
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, "// packaged worker fixture\n");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  check("the input guardian has its own packaged executable/runtime handshake gate", () => {
    const guardian = path.join(unpacked, "out/main/input-guardian.cjs");
    const ready = { protocol: 1, backend: "linux-atspi-input-guardian", nodeVersion: "24.1.0", pid: 234, ready: true };
    fs.writeFileSync(guardian, "// guardian fixture\n");
    const verify = (reply) => verifyInputGuardianRuntime(appDir, "mybuddy", unpacked, {
      spawnSync: (exe, args, options) => {
        assert.equal(exe, path.join(appDir, "mybuddy"));
        assert.deepEqual(args, [guardian, "--handshake"]);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
        return reply;
      },
    });
    assert.equal(verify({ status: 0, stdout: JSON.stringify(ready) }).ok, true);
    assert.equal(verify({ status: 0, stdout: JSON.stringify({ ...ready, nodeVersion: "22.12.0" }) }).ok, false);
    assert.equal(verify({ status: 0, stdout: JSON.stringify({ ...ready, backend: "wrong-worker" }) }).ok, false);
    assert.equal(verify({ status: 0, stdout: "garbage" }).ok, false);
    assert.equal(verify({ status: 1, stdout: JSON.stringify(ready) }).ok, false);
    fs.rmSync(guardian);
    assert.equal(verifyInputGuardianRuntime(appDir, "mybuddy", unpacked).ok, false);
  });

  check("the AT-SPI payload probe executes the packaged Electron binary, with child-only Node mode", () => {
    const parentMode = process.env.ELECTRON_RUN_AS_NODE;
    let calls = 0;
    const result = verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, {
      spawnSync: (exe, args, options) => {
        calls += 1;
        assert.equal(exe, path.join(appDir, "mybuddy"));
        assert.deepEqual(args, [worker, "--handshake"]);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
        assert.notEqual(options.env, process.env);
        assert.equal(options.env.MYBUDDY_CUL_BIN, undefined);
        assert.equal(options.cwd, appDir);
        assert.ok(options.timeout > 0 && options.timeout <= 15_000);
        assert.equal(options.shell, undefined);
        return { status: 0, stdout: JSON.stringify(good), stderr: "" };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.facts.atspiWorkerRuntime, "packaged-electron");
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, parentMode);
  });

  check("an installed system Node cannot compensate for an old Electron Node", () => {
    const result = probe({ ...good, nodeVersion: "22.12.0" });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /packaged Electron Node 22\.12\.0/);
  });

  check("runtime, backend, protocol and process identity must all match the handshake contract", () => {
    for (const patch of [
      { ready: false }, { backend: "other" }, { protocol: 2 },
      { dbusNativeVersion: "0.0.0" }, { pid: 0 }, { nodeVersion: "unknown" },
    ]) {
      assert.equal(probe({ ...good, ...patch }).ok, false, JSON.stringify(patch));
    }
  });

  check("worker failures and malformed output cannot be accepted as a payload pass", () => {
    assert.equal(probe(good, 1).ok, false);
    assert.equal(verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, {
      spawnSync: () => { throw new Error("spawn denied"); },
    }).ok, false);
    for (const run of [
      { status: null, error: new Error("ETIMEDOUT"), stdout: "", stderr: "" },
      { status: 0, stdout: "not a handshake", stderr: "" },
      { status: 0, stdout: "", stderr: "" },
    ]) {
      const result = verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, { spawnSync: () => run });
      assert.equal(result.ok, false);
    }
  });

  check("missing payloads fail before any child process is launched", () => {
    let calls = 0;
    const options = { spawnSync: () => { calls += 1; throw new Error("must not run"); } };
    assert.equal(verifyLinuxWorkerRuntime(appDir, null, unpacked, options).ok, false);
    fs.renameSync(worker, `${worker}.saved`);
    assert.equal(verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, options).ok, false);
    fs.renameSync(`${worker}.saved`, worker);
    fs.writeFileSync(manifestPath, "{}");
    assert.equal(verifyLinuxWorkerRuntime(appDir, "mybuddy", unpacked, options).ok, false);
    assert.equal(calls, 0);
  });

  check("Node version comparisons enforce numeric major/minor/patch boundaries", () => {
    assert.equal(nodeVersionAtLeast("24.0.0", "24.0.0"), true);
    assert.equal(nodeVersionAtLeast("24.9.0", "24.10.0"), false);
    assert.equal(nodeVersionAtLeast("25.0.0", "24.10.0"), true);
    assert.equal(nodeVersionAtLeast("24.0.0-not-a-release", "24.0.0"), false);
    assert.equal(nodeVersionAtLeast(null, "24.0.0"), false);
  });
  console.log(`linux-worker-packaging: ${results.length} passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
