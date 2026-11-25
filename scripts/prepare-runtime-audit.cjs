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

function verify(target, directory) {
  const executable = path.join(directory, platforms[target].executable);
  fs.accessSync(executable, host === target ? fs.constants.X_OK : fs.constants.F_OK);
  if (host === target) {
    const result = execFileSync(executable, ["--protocol-version"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    }).trim();
    if (result !== "86") throw new Error("Runtime audit executable protocol mismatch");
  }
}

function prepare(target) {
  if (target !== host) throw new Error(`Build runtime audit on its native host (${target})`);
  const { executable, target: triple } = platforms[target];
  const output = path.join(root, "out", "native", target);
  const build = path.join(root, "out", "native", "runtime-audit-build");
  const receipt = path.join(build, `${target}.sha256`);
  const files = ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(crate, "src"))
    .filter(name => name.endsWith(".rs")).sort().map(name => path.join("src", name))];
  const fingerprint = createHash("sha256");
  for (const file of files) fingerprint.update(file).update("\0").update(fs.readFileSync(path.join(crate, file))).update("\0");
  const digest = fingerprint.digest("hex");
  if (fs.existsSync(path.join(output, executable)) && fs.existsSync(receipt)
      && fs.readFileSync(receipt, "utf8") === digest) return;
  execFileSync("cargo", [
    "build", "--locked", "--release", "--target", triple, "--target-dir", build,
  ], { cwd: crate, stdio: "inherit", windowsHide: true, timeout: 600_000 });
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(build, triple, "release", executable), path.join(output, executable));
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
