/**
 * test-guard.mjs — 统一测试执行护栏（内存 + 总超时 + 进程树终止）。
 *
 * 背景（2026-08-15 事故）：`node out/tests/project-cadence-test.cjs` 一次 OOM 无限环
 * 在 ~7 分钟内 commit 冲到 113–114GB，把整机虚拟内存耗尽（R.E.D. 2004，commit 99.9%）。
 * `--max-old-space-size` 只约束 V8 堆；Buffer/ArrayBuffer 等外部内存仍可无限增长，
 * 因此本护栏在进程外做独立监控，超限即终止整个子进程树。
 *
 * 用法（包一层 node 测试进程）：
 *   node scripts/test-guard.mjs node out/tests/xxx.cjs
 * 环境变量覆盖：
 *   GUARD_MEM_MB      总内存（WorkingSet + Commit）上限，默认 6144（6GB）
 *   GUARD_TIMEOUT_S   墙钟总超时（到点 kill 整树），默认 900
 *   GUARD_POLL_MS     内存采样间隔，默认 1500
 *   GUARD_V8_HEAP_MB  追加的 --max-old-space-size，默认 4096（已带该参数则不重复加）
 *   GUARD_HOME        默认 'sandbox'：给子进程一个临时 HOME（避免用例把夹具数据写进真实 ~/.mybuddy）；
 *                     设成 'host' 可关闭隔离；GUARD_KEEP_HOME=1 保留沙箱目录便于排查。
 *
 * 退出码：子进程退出码原样透传；护栏触发 → 137（内存）/ 124（超时）。
 * 终止：Windows 用 taskkill /PID /T /F（可靠杀整树）；POSIX 用进程组 SIGKILL。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEM_MB = Number(process.env.GUARD_MEM_MB ?? 6144);
const TIMEOUT_S = Number(process.env.GUARD_TIMEOUT_S ?? 900);
const POLL_MS = Number(process.env.GUARD_POLL_MS ?? 1500);
const V8_HEAP_MB = Number(process.env.GUARD_V8_HEAP_MB ?? 4096);
const IS_WIN = process.platform === "win32";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("用法: node scripts/test-guard.mjs <cmd> [args...]  （例: node scripts/test-guard.mjs node out/tests/x.cjs）");
  process.exit(2);
}

/** 是否为 node 可执行（需要注入 --max-old-space-size 的场合） */
function isNodeBinary(name) {
  const base = name.split(/[\\/]/).pop() ?? name;
  return /^node(\.exe)?$/i.test(base);
}

const childArgs = [...argv];
// 直接给 JS 文件时自动补 node 前缀（`node scripts/test-guard.mjs out/tests/x.cjs` 的惯用写法）
if (!isNodeBinary(childArgs[0]) && /\.(cjs|mjs|js)$/i.test(childArgs[0] ?? "")) {
  childArgs.unshift("node");
}
if (isNodeBinary(childArgs[0]) && !childArgs.some((a) => a.startsWith("--max-old-space-size="))) {
  childArgs.splice(1, 0, `--max-old-space-size=${V8_HEAP_MB}`);
}

const startedAt = Date.now();

/**
 * 默认隔离 HOME：大量用例会把夹具数据写到 ~/.mybuddy（资料库文档、技能、模式 profile…），
 * POSIX 的 os.homedir() 读的是 HOME，没有隔离就会污染真实用户数据，也会让用例互相影响。
 * 需要真实家目录的用例显式设置 GUARD_HOME=host。
 */
const isolateHome = (process.env.GUARD_HOME ?? "sandbox") !== "host";
let sandboxHome = null;
const childEnv = { ...process.env };
if (isolateHome) {
  sandboxHome = mkdtempSync(join(tmpdir(), "mybuddy-test-home-"));
  childEnv.HOME = sandboxHome;
  childEnv.USERPROFILE = sandboxHome;
  childEnv.XDG_CONFIG_HOME = join(sandboxHome, ".config");
  childEnv.XDG_CACHE_HOME = join(sandboxHome, ".cache");
  childEnv.XDG_DATA_HOME = join(sandboxHome, ".local", "share");
  childEnv.XDG_STATE_HOME = join(sandboxHome, ".local", "state");
}

// 子进程统一 UTF-8：CI 的 Windows runner 默认代码页是 cp1252（中文 Windows 是 cp936），
// 用例里 `python - <<PY` 打印中文会按 locale 编码失败——builtin-capabilities 的
// EXEC_UNICODE_OK_中文 在 runner 上就是这么红的（本机 UTF-8 环境是绿的）。
// 只作用于测试子进程，不改产品行为。
childEnv.PYTHONUTF8 = "1";
childEnv.PYTHONIOENCODING = "utf-8";

let child;
try {
  child = spawn(childArgs[0], childArgs.slice(1), {
    stdio: "inherit",
    windowsHide: true,
    env: childEnv,
    // POSIX：独立进程组，便于整组 SIGKILL
    detached: !IS_WIN,
  });
} catch (err) {
  console.error(`[test-guard] 子进程启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

console.error(
  `[test-guard] pid=${child.pid} cmd=${childArgs.join(" ")} mem_cap=${MEM_MB}MB timeout=${TIMEOUT_S}s poll=${POLL_MS}ms`,
);

/** Windows：pwsh -EncodedCommand 读子进程 WorkingSet + PrivatePageCount（私有 commit，demand-zero 大块分配的唯一可靠口径；R.E.D. CommitCharge≈PrivatePageCount）；POSIX：读 /proc VmRSS+VmSwap */
function readMem(pid) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      let ps;
      try {
        const script = [
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
          `if ($p) { "{0} {1}" -f $p.WorkingSetSize, $p.PrivatePageCount }`,
        ].join("; ");
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      ps.stdout.on("data", (d) => (out += String(d)));
      ps.on("close", () => {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out.trim());
        resolve(m ? { ws: Number(m[1]), commit: Number(m[2]) } : null);
      });
      ps.on("error", () => resolve(null));
      return;
    }
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      const swap = /^VmSwap:\s+(\d+) kB$/m.exec(status);
      resolve({
        ws: rss ? Number(rss[1]) * 1024 : 0,
        commit: swap ? Number(swap[1]) * 1024 : 0,
      });
    } catch {
      resolve(null);
    }
  });
}

/** 终止整个子进程树（Windows: taskkill /T；POSIX: 进程组 SIGKILL） */
function killTree(pid) {
  try {
    if (IS_WIN) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

let settled = false;
let timer = null;
let poller = null;

function cleanupSandboxHome() {
  if (!sandboxHome || process.env.GUARD_KEEP_HOME === "1") return;
  try { rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
}

function finish(code, reason) {
  if (settled) return;
  settled = true;
  cleanupSandboxHome();
  clearInterval(poller);
  clearTimeout(timer);
  if (reason) {
    console.error(`[test-guard] ${reason}`);
  }
  console.error(
    `[test-guard] exit pid=${child.pid} code=${code} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  process.exitCode = code;
}

child.on("error", (err) => {
  finish(2, `[test-guard] 子进程启动失败: ${err.message}`);
});

child.on("exit", (code, signal) => {
  if (settled) return;
  const c = code ?? (signal ? 1 : 0);
  finish(c, null);
});

// 总超时：到点杀整树（防挂死测试无界占用）
timer = setTimeout(() => {
  console.error(
    `[test-guard] KILL pid=${child.pid} reason=timeout=${TIMEOUT_S}s elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  killTree(child.pid);
  finish(124, null);
}, TIMEOUT_S * 1000);
timer.unref?.();

// 内存看门狗：周期性采样，超限即杀（不依赖 V8 堆上限，外部内存同样受控）
poller = setInterval(async () => {
  if (settled || !child.pid) return;
  const mem = await readMem(child.pid);
  if (process.env.GUARD_DEBUG) {
    console.error(`[test-guard][dbg] pid=${child.pid} mem=${mem ? JSON.stringify(mem) : "null"}`);
  }
  if (settled || !mem) return;
  // demand-zero 大块分配场景：WS 可能极小（不驻留），私有 commit 才是事故口径 → 取 max 防漏判
  const totalMb = Math.max(mem.ws, mem.commit) / (1024 * 1024);
  if (totalMb > MEM_MB) {
    console.error(
      `[test-guard] KILL pid=${child.pid} reason=memory ${totalMb.toFixed(0)}MB (ws=${(mem.ws / 1048576).toFixed(0)}MB private_commit=${(mem.commit / 1048576).toFixed(0)}MB) > cap=${MEM_MB}MB elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    killTree(child.pid);
    finish(137, null);
  }
}, POLL_MS);
poller.unref?.();
