const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const crate = path.join(root, "native", "runtime-audit");
const platforms = {
  "win-x64": { target: "x86_64-pc-windows-msvc", executable: "mybuddy-runtime-audit.exe" },
  "linux-x64": { target: "x86_64-unknown-linux-gnu", executable: "mybuddy-runtime-audit" },
};
const host = process.arch === "x64"
  ? ({ win32: "win-x64", linux: "linux-x64" })[process.platform] : undefined;
const [command, directory] = process.argv.slice(2);

function ensureMediumIntegrity(targetPath, inherit = false) {
  if (process.platform !== "win32") return;
  // A Low-integrity workspace marks copied/built executables Low, so Windows launches
  // the worker at Low IL and blocks writes to ~/.mybuddy and %LOCALAPPDATA%\Temp.
  const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  execFileSync(icacls, [targetPath, "/setintegritylevel", inherit ? "(OI)(CI)M" : "M", "/L", "/Q"], {
    windowsHide: true, timeout: 15_000,
  });
}

function ensureExecutableTreeMedium(directory) {
  if (process.platform !== "win32" || !fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) ensureExecutableTreeMedium(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) ensureMediumIntegrity(full);
  }
}

function verify(target, directory) {
  const executable = path.join(directory, platforms[target].executable);
  fs.accessSync(executable, host === target ? fs.constants.X_OK : fs.constants.F_OK);
  if (host === target) {
    const result = execFileSync(executable, ["--protocol-version"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    }).trim();
    if (result !== "117") throw new Error("Runtime audit executable protocol mismatch");
  }
}

// The packed worker is the only copy of the state/restore protocol, so its own tests
// gate the build. They run on CI (or with RUNTIME_AUDIT_TESTS=1) because they need a
// writable temp dir and a C toolchain, which local dev shells do not always have.
function verifyCrateTests(target, build) {
  if (!process.env.CI && process.env.RUNTIME_AUDIT_TESTS !== "1") return;
  const args = [
    "test", "--locked", "--release", "--target", platforms[target].target, "--target-dir", build,
  ];
  if (target === "win-x64") {
    execFileSync("cargo", [...args, "--no-run"], {
      cwd: crate, stdio: "inherit", windowsHide: true, timeout: 900_000,
    });
    ensureExecutableTreeMedium(path.join(build, platforms[target].target, "release", "deps"));
  }
  execFileSync("cargo", args, {
    cwd: crate, stdio: "inherit", windowsHide: true, timeout: 900_000,
  });
}

function prepare(target) {
  if (target !== host) throw new Error(`Build runtime audit on its native host (${target})`);
  const { executable, target: triple } = platforms[target];
  const output = path.join(root, "out", "native", target);
  const build = path.join(root, "out", "native", "runtime-audit-build");
  const receipt = path.join(build, `${target}.sha256`);
  const files = ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(crate, "src"))
    .filter(name => name.endsWith(".rs") || name.endsWith(".sql")).sort().map(name => path.join("src", name))];
  const fingerprint = createHash("sha256");
  for (const file of files) fingerprint.update(file).update("\0").update(fs.readFileSync(path.join(crate, file))).update("\0");
  const digest = fingerprint.digest("hex");
  fs.mkdirSync(build, { recursive: true });
  if (target === "win-x64") ensureMediumIntegrity(build, true);
  // Runs before the cache check: a cached binary still has to prove its tests pass.
  verifyCrateTests(target, build);
  const packaged = path.join(output, executable);
  if (fs.existsSync(packaged) && fs.existsSync(receipt)
      && fs.readFileSync(receipt, "utf8") === digest) {
    if (target === "win-x64") ensureMediumIntegrity(packaged);
    return;
  }
  execFileSync("cargo", [
    "build", "--locked", "--release", "--target", triple, "--target-dir", build,
  ], { cwd: crate, stdio: "inherit", windowsHide: true, timeout: 600_000 });
  fs.mkdirSync(output, { recursive: true });
  if (target === "win-x64") ensureMediumIntegrity(output, true);
  fs.copyFileSync(path.join(build, triple, "release", executable), packaged);
  if (target === "win-x64") ensureMediumIntegrity(packaged);
  verify(target, output);
  fs.writeFileSync(receipt, digest);
}

if (command === "--verify") {
  const target = process.argv[4];
  if (!directory || !platforms[target]) throw new Error("Expected --verify DIRECTORY PLATFORM");
  verify(target, directory);
} else if (command === "--dev") {
  if (host) {
    try { prepare(host); }
    catch (error) { console.warn(`[RuntimeAudit] Host reader will be used if native preparation is unavailable: ${error.message}`); }
  }
} else {
  const target = command ?? host;
  if (!target || !platforms[target]) throw new Error("Unsupported runtime audit target");
  prepare(target);
}
