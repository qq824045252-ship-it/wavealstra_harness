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
const argv = process.argv.slice(2);
const SUBCOMMANDS = new Set(["--verify", "--dev"]);
// 命令可以是 --verify / --dev，也可以直接是目标三元组；flag 顺序不影响解析。
const command = argv.find(arg => SUBCOMMANDS.has(arg)) ?? argv.find(arg => !arg.startsWith("--"));
const flags = new Set(argv.filter(arg => arg.startsWith("--") && arg !== command));
const positionals = argv.filter(arg => !arg.startsWith("--") && arg !== command);
const [directory] = positionals;
// --force 只跳过 sha256 receipt 缓存；--clean 先删掉 target 目录，让 DuckDB 的 C++ 侧从零重编。
const force = flags.has("--force");
const clean = flags.has("--clean");
const nodeOs = require("node:os");
const logicalCpus = typeof nodeOs.availableParallelism === "function"
  ? nodeOs.availableParallelism()
  : (nodeOs.cpus() || []).length || 4;
// 全量 DuckDB C++ 重编时把每个逻辑核都占满，链接/归档阶段会没有余量，且 14 个 cl.exe
// 同时啃 unity build 的 TU 很容易把 32 GB 内存压到交换。默认留 2 个核给系统与链接器
// （16 逻辑核 → 14 个并行编译），需要时用 RUNTIME_AUDIT_JOBS 覆盖。
const defaultJobs = Math.max(1, logicalCpus - 2);
const configuredJobs = Number(process.env.RUNTIME_AUDIT_JOBS);
const jobs = Number.isInteger(configuredJobs) && configuredJobs > 0 ? configuredJobs : defaultJobs;

let cachedBuildTools;

function windowsSdkEnvironment(env) {
  const roots = [
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Windows Kits", "10"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Windows Kits", "10"),
    "C:\\Program Files (x86)\\Windows Kits\\10",
    "C:\\Program Files\\Windows Kits\\10",
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const includeRoot = path.join(root, "Include");
    const libRoot = path.join(root, "Lib");
    const version = fs.existsSync(includeRoot)
      ? fs.readdirSync(includeRoot).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort().reverse()[0]
      : undefined;
    if (!version || !fs.existsSync(path.join(libRoot, version))) continue;
    const include = ["ucrt", "um", "shared", "winrt", "cppwinrt"]
      .map(name => path.join(includeRoot, version, name)).filter(p => fs.existsSync(p));
    const lib = ["ucrt", "um"]
      .map(name => path.join(libRoot, version, name, "x64")).filter(p => fs.existsSync(p));
    if (include.length && lib.length) return { root, version, include, lib };
  }
}

function msvcEnvironmentFromFilesystem(install, env) {
  const vcRoot = path.join(install, "VC", "Tools", "MSVC");
  if (!fs.existsSync(vcRoot)) return false;
  let version = "";
  try {
    version = fs.readFileSync(path.join(install, "VC", "Auxiliary", "Build", "Microsoft.VCToolsVersion.default.txt"), "utf8").trim();
  } catch {}
  if (!version || !fs.existsSync(path.join(vcRoot, version))) {
    version = fs.readdirSync(vcRoot).filter(name => /^\d+\.\d+/.test(name)).sort().reverse()[0] || "";
  }
  const vc = path.join(vcRoot, version);
  const includeDir = path.join(vc, "include");
  const libDir = path.join(vc, "lib", "x64");
  const binDir = path.join(vc, "bin", "HostX64", "x64");
  if (!version || !fs.existsSync(includeDir) || !fs.existsSync(libDir) || !fs.existsSync(binDir)) return false;
  const sdk = windowsSdkEnvironment(env);
  const include = [includeDir, ...(sdk ? sdk.include : [])];
  const lib = [libDir, ...(sdk ? sdk.lib : [])];
  env.VCToolsInstallDir = vc + path.sep;
  env.VCINSTALLDIR = path.join(install, "VC") + path.sep;
  env.INCLUDE = include.join(path.delimiter);
  env.LIB = lib.join(path.delimiter);
  env.LIBPATH = lib.join(path.delimiter);
  if (sdk) {
    env.WindowsSdkDir = sdk.root + path.sep;
    env.WindowsSDKVersion = sdk.version + path.sep;
  }
  const additions = [binDir];
  const cmake = path.join(install, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin");
  const ninja = path.join(install, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja");
  if (fs.existsSync(cmake)) additions.push(cmake);
  if (fs.existsSync(ninja)) additions.push(ninja);
  env.Path = [...additions, env.Path || env.PATH || ""].join(path.delimiter);
  delete env.PATH;
  return true;
}

function rustBuildTools() {
  if (cachedBuildTools) return cachedBuildTools;
  if (process.platform !== "win32") return { cargo: "cargo", env: process.env, usesExternalTargetDir: false };
  const options = { encoding: "utf8", windowsHide: true, timeout: 10_000 };
  const env = { ...process.env };
  let cargo = "cargo";
  let cargoVersion = "";
  let hasRustc = false;
  try { cargoVersion = execFileSync("cargo", ["--version"], options); } catch {}
  try { execFileSync("rustc", ["-vV"], options); hasRustc = true; } catch {}
  const usesExternalTargetDir = /huacnlee\/cargo/i.test(cargoVersion);
  if (!cargoVersion || !hasRustc) {
    const home = env.RUSTUP_HOME || path.join(require("node:os").homedir(), ".rustup");
    let configured;
    try {
      configured = /^default_toolchain\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(home, "settings.toml"), "utf8"))?.[1];
    } catch {}
    const toolchain = env.RUSTUP_TOOLCHAIN || configured || "stable-x86_64-pc-windows-msvc";
    if (!/^[\w.-]+$/.test(toolchain) || toolchain === "." || toolchain === "..") throw new Error("Invalid Rust toolchain name");
    const name = /-pc-windows-(?:msvc|gnu)$/.test(toolchain) ? toolchain : toolchain + "-x86_64-pc-windows-msvc";
    const bin = path.join(home, "toolchains", name, "bin");
    for (const file of ["cargo.exe", "rustc.exe"]) {
      if (!fs.existsSync(path.join(bin, file))) throw new Error("A complete standard Rust toolchain is required: " + bin);
    }
    const existingPath = env.Path || env.PATH || "";
    if (!cargoVersion) {
      env.Path = bin + path.delimiter + existingPath;
      cargo = path.join(bin, "cargo.exe");
      console.log("[RuntimeAudit] Using standard Rust toolchain " + name);
    } else {
      // Keep the user's preferred cargo (e.g. ~/.cargo/bin) so cache is shared,
      // and append rustup's toolchain bin so rustc.exe is resolvable.
      env.Path = existingPath ? existingPath + path.delimiter + bin : bin;
      console.log("[RuntimeAudit] Using existing cargo with rustc from " + name);
    }
    delete env.PATH;
  }
  // An ordinary PowerShell may resolve Git's link.exe instead of MSVC's.
  // Prefer setting the MSVC environment directly from the installed toolchain:
  // vcvars64.bat invokes reg.exe, which is unavailable in restricted shells.
  if (!env.VCToolsInstallDir && !env.VCINSTALLDIR) {
    const programFiles = env["ProgramFiles(x86)"];
    const vswhere = programFiles && path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    let install = "";
    if (vswhere && fs.existsSync(vswhere)) {
      try {
        install = execFileSync(vswhere, ["-latest", "-products", "*", "-requires",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], options).trim();
      } catch {}
    }
    if (install && msvcEnvironmentFromFilesystem(install, env)) {
      console.log("[RuntimeAudit] Using MSVC toolchain from " + install);
    } else if (install) {
      const vc = path.join(install, "VC", "Auxiliary", "Build");
      if (!fs.existsSync(path.join(vc, "vcvars64.bat"))) throw new Error("MSVC x64 build tools are required: " + vc);
      const cmd = path.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
      const output = execFileSync(cmd, ["/d", "/c", "call vcvars64.bat >nul && set"], {
        ...options, cwd: vc, timeout: 30_000, env: { ...env, VSCMD_SKIP_SENDTELEMETRY: "1" },
      });
      const updates = new Map();
      for (const line of output.split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at > 0) updates.set(line.slice(0, at).toUpperCase(), [line.slice(0, at), line.slice(at + 1)]);
      }
      for (const key of Object.keys(env)) if (updates.has(key.toUpperCase())) delete env[key];
      for (const [key, value] of updates.values()) env[key] = value;
      if (!env.VCToolsInstallDir && !env.VCINSTALLDIR) throw new Error("MSVC environment did not initialize");
    } else {
      throw new Error("MSVC x64 build tools are required (Visual Studio Build Tools with VC tools x86/x64)");
    }
  }
  return cachedBuildTools = { cargo, env, usesExternalTargetDir };
}

function runCargo(args, buildOptions) {
  const { cargo, env } = rustBuildTools();
  const [subcommand, ...rest] = args;
  // cc-rs's `parallel` feature honours Cargo's -j; Cargo derives NUM_JOBS for
  // build scripts itself. Setting NUM_JOBS here as well can deadlock the jobserver.
  execFileSync(cargo, [subcommand, "-j", String(jobs), ...rest], { ...buildOptions, env });
}

function runCargoArtifacts(args, buildOptions) {
  const { cargo, env } = rustBuildTools();
  const [subcommand, ...rest] = args;
  const stdout = execFileSync(
    cargo,
    [subcommand, "-j", String(jobs), "--message-format=json-render-diagnostics", ...rest],
    { ...buildOptions, env, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const executables = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.reason === "compiler-artifact" && typeof msg.executable === "string" && msg.executable) {
        executables.push(msg.executable);
      }
    } catch {}
  }
  return executables;
}


// A Low-integrity workspace marks copied/built executables Low, so Windows launches
// the worker at Low IL and blocks writes to ~/.mybuddy and %LOCALAPPDATA%\Temp.
//
// 只对**可执行文件**设置完整性级别，绝不对目录设置。实测 `icacls <dir> /setintegritylevel
// (OI)(CI)M` 会按子树体积耗时：355 MB 的 build 目录要 55 s，190 MB 要 33 s，5.3 GB 的
// 全量 target 目录要十几分钟（"Successfully processed 1 files" 之后才返回）。而 Windows
// 决定进程 IL 时只看被启动的 image 文件，.o / .rlib / .a 的 IL 无意义。
//
// 注意 `icacls` 的 /setintegritylevel 只接受**一个**名字：`icacls a.exe b.exe /setintegritylevel M`
// 会以 87 (ERROR_INVALID_PARAMETER) 拒绝第二个名字，所以只能逐个文件调用（每个 0.5 s 级）。
function ensureExecutablesMedium(files) {
  if (process.platform !== "win32") return;
  const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  for (const file of files) {
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    execFileSync(icacls, [file, "/setintegritylevel", "M", "/L", "/Q"], {
      windowsHide: true, timeout: 60_000,
    });
  }
}

function executableTree(directory) {
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) found.push(full);
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return found;
}

function verify(target, directory) {
  const executable = path.join(directory, platforms[target].executable);
  fs.accessSync(executable, host === target ? fs.constants.X_OK : fs.constants.F_OK);
  if (host === target) {
    const result = execFileSync(executable, ["--protocol-version"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    }).trim();
    if (result !== "121") throw new Error("Runtime audit executable protocol mismatch");
  }
}

// The packed worker is the only copy of the state/restore protocol, so its own tests
// gate the build. They run on CI (or with RUNTIME_AUDIT_TESTS=1) because they need a
// writable temp dir and a C toolchain, which local dev shells do not always have.
// 调用点固定在二进制构建之后：放在前面会让 dev-deps 抢光 jobserver token。
function verifyCrateTests(target, build) {
  if (!process.env.CI && process.env.RUNTIME_AUDIT_TESTS !== "1") return;
  const { usesExternalTargetDir } = rustBuildTools();
  const args = usesExternalTargetDir
    ? ["test", "--locked", "--release"]
    : ["test", "--locked", "--release", "--target", platforms[target].target, "--target-dir", build];
  if (target === "win-x64") {
    const built = runCargoArtifacts([...args, "--no-run"], {
      cwd: crate, windowsHide: true, timeout: 3_600_000,
    });
    const toFix = built.length
      ? built
      : executableTree(path.join(build, platforms[target].target, "release", "deps"));
    ensureExecutablesMedium(toFix);
  }
  runCargo(args, {
    cwd: crate, stdio: "inherit", windowsHide: true, timeout: 900_000,
  });
}

function prepare(target) {
  if (target !== host) throw new Error(`Build runtime audit on its native host (${target})`);
  const { executable, target: triple } = platforms[target];
  const output = path.join(root, "out", "native", target);
  const buildName = process.env.RUNTIME_AUDIT_BUILD_DIR || "runtime-audit-build";
  if (!/^[\w.-]+$/.test(buildName)) throw new Error("Invalid RUNTIME_AUDIT_BUILD_DIR");
  const build = path.join(root, "out", "native", buildName);
  const receipt = path.join(build, `${target}.sha256`);
  const files = ["Cargo.toml", "Cargo.lock", ...fs.readdirSync(path.join(crate, "src"))
    .filter(name => name.endsWith(".rs") || name.endsWith(".sql")).sort().map(name => path.join("src", name))];
  const fingerprint = createHash("sha256");
  for (const file of files) fingerprint.update(file).update("\0").update(fs.readFileSync(path.join(crate, file))).update("\0");
  const digest = fingerprint.digest("hex");
  if (clean && fs.existsSync(build)) {
    console.log(`[RuntimeAudit] --clean: removing ${build}`);
    fs.rmSync(build, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  fs.mkdirSync(build, { recursive: true });
  const packaged = path.join(output, executable);
  const cached = !force && fs.existsSync(packaged) && fs.existsSync(receipt)
    && fs.readFileSync(receipt, "utf8") === digest;
  // 自测必须过门，但**不能**跑在 DuckDB 的 C++ 阶段前面：`cargo test --no-run` 会把
  // arrow 等 300 多个 dev-deps 一起压进 cargo jobserver，`cc-rs` 的并行编译只能分到
  // 1 个 token，于是 316 个 TU 退化成单线程（实测 44 分钟，全程只有 1 个 cl.exe）。
  // 顺序改成：先出二进制（C++ 阶段独占 jobserver）→ 再跑自测 → 自测通过才发布产物。
  if (cached) {
    verifyCrateTests(target, build);
    if (target === "win-x64") ensureExecutablesMedium([packaged]);
    return;
  }
  const { usesExternalTargetDir } = rustBuildTools();
  const buildArgs = usesExternalTargetDir
    ? ["build", "--locked", "--release"]
    : ["build", "--locked", "--release", "--target", triple, "--target-dir", build];
  console.log(
    `[RuntimeAudit] cargo build -j ${jobs} (logical CPUs: ${logicalCpus}, target dir: ${usesExternalTargetDir ? "shared cargo cache" : path.relative(root, build)})`,
  );
  const builtExecutables = runCargoArtifacts(buildArgs, {
    cwd: crate, windowsHide: true, timeout: 3_600_000,
  });
  const builtBinary = builtExecutables.find(file => path.basename(file).toLowerCase() === executable.toLowerCase())
    || path.join(build, triple, "release", executable);
  verifyCrateTests(target, build);
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(builtBinary, packaged);
  if (target === "win-x64") ensureExecutablesMedium([packaged]);
  verify(target, output);
  fs.writeFileSync(receipt, digest);
}

if (command === "--verify") {
  const target = positionals[1];
  if (!directory || !platforms[target]) throw new Error("Expected --verify DIRECTORY PLATFORM");
  verify(target, directory);
} else if (command === "--dev") {
  if (host) prepare(host);
} else {
  const target = command ?? host;
  if (!target || !platforms[target]) throw new Error("Unsupported runtime audit target");
  prepare(target);
}
