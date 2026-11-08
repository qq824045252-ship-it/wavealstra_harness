/**
 * Issue #17 A1 startup phase baseline (dev mode).
 *
 * Runs `pnpm dev` with an isolated HOME/XDG profile and MYBUDDY_PERF_ISSUE17=1, then waits for the
 * main process to report phase marks:
 *   appReady → windowCreated → rendererLoaded → bootstrapApplied → taskListInteractive
 *   → restoreDelivered → cronReady → gatewayRestored → memoryGatewayReady → remoteAccessReady
 *
 * Dev-mode numbers include electron-vite startup and are NOT comparable with a packaged build or
 * with another machine. Use them for before/after comparisons on the same machine and mode only;
 * an absolute claim needs an authorized packaged run.
 */
const { execSync, spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const MARKER = "MYBUDDY_PERF_ISSUE17:";
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const runs = Math.max(1, Number(readArg("runs", "3")));
const bindings = Math.max(0, Number(readArg("bindings", "0")));
const timeoutMs = Math.max(5_000, Number(readArg("timeout", "90000")));
const sha = execSync("git rev-parse HEAD", { cwd: process.cwd(), encoding: "utf8" }).trim();

/** pnpm/electron-vite may leave grandchildren outside our group; kill the tree explicitly. */
function killTree(pid, signal) {
  const stack = [pid];
  const pids = [];
  while (stack.length) {
    const current = stack.pop();
    pids.push(current);
    let children = [];
    try {
      children = execSync(`pgrep -P ${current}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim().split(/\s+/).filter(Boolean).map(Number);
    } catch { /* no children */ }
    stack.push(...children);
  }
  for (const target of pids.reverse()) {
    try { process.kill(target, signal); } catch { /* already gone */ }
  }
}

const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * q))] ?? 0;
  return { n: values.length, p50Ms: at(0.5), p95Ms: at(0.95), minMs: sorted[0] ?? 0, maxMs: sorted.at(-1) ?? 0 };
};

function runOnce(index, reusedProfile) {
  const profile = reusedProfile ?? mkdtempSync(join(tmpdir(), `mybuddy-issue17-dev-${index}-`));
  const env = {
    ...process.env,
    MYBUDDY_PERF_ISSUE17: "1",
    HOME: profile,
    USERPROFILE: profile,
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_DATA_HOME: join(profile, "data"),
    XDG_CACHE_HOME: join(profile, "cache"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  mkdirSync(join(profile, "config"), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["dev"], { cwd: process.cwd(), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child.pid, "SIGTERM");
      setTimeout(() => {
        killTree(child.pid, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        if (!reusedProfile) rmSync(profile, { recursive: true, force: true });
        resolve(result);
      }, 1_500);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: `timeout after ${timeoutMs}ms`, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) }),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith(MARKER));
      if (!line) return;
      try {
        finish({ ok: true, report: JSON.parse(line.slice(MARKER.length)), stderr: stderr.slice(-2000) });
      } catch (error) {
        finish({ ok: false, error: `unparsable marker: ${String(error)}`, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ ok: false, error: `spawn failed: ${String(error)}` }));
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, error: `process exited (${code}) before the marker`, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
    });
  });
}

function seedBindings(profile, count) {
  // The schema belongs to AppDatabase; a warm-up launch creates it, then we add tasks + bindings.
  const Database = require("better-sqlite3");
  const { mkdirSync } = require("node:fs");
  const dbPath = join(profile, ".mybuddy", "app.db");
  const db = new Database(dbPath);
  try {
    const insertTask = db.prepare(`INSERT OR REPLACE INTO tasks (id, title, status, updated_at, cwd, welcome_mode)
      VALUES (?, ?, 'pending', ?, ?, 'general')`);
    const insertBinding = db.prepare(`INSERT OR REPLACE INTO durable_bot_bindings (task_id, backend, directory, cwd)
      VALUES (?, 'pi-durable', ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const id = `issue17-session-${String(index).padStart(4, "0")}`;
        const cwd = join(profile, "work", String(index));
        mkdirSync(cwd, { recursive: true });
        insertTask.run(id, `Session ${index}`, now - index, cwd);
        insertBinding.run(id, join(profile, ".mybuddy", "durable", String(index)), cwd);
      }
    })();
    return db.prepare("SELECT COUNT(*) AS count FROM durable_bot_bindings").get().count;
  } finally { db.close(); }
}

async function main() {
  const startedAt = new Date().toISOString();
  const samples = [];
  let seededBindings = 0;
  let profile;
  if (bindings > 0) {
    profile = mkdtempSync(join(tmpdir(), "mybuddy-issue17-bindings-"));
    process.stdout.write("[issue17-startup] schema warm-up … ");
    const warm = await runOnce(0, profile);
    process.stdout.write(warm.ok ? "ok\n" : `FAILED: ${warm.error}\n`);
    seededBindings = seedBindings(profile, bindings);
    process.stdout.write(`[issue17-startup] seeded ${seededBindings} durable bindings\n`);
  }
  for (let index = 0; index < runs; index += 1) {
    const manualRun = String(index + 1).padStart(2, "0");
    process.stdout.write(`[issue17-startup] dev run ${manualRun}/${runs} … `);
    const result = await runOnce(index, profile);
    process.stdout.write(result.ok ? (result.report.complete ? "complete\n" : `incomplete (missing ${result.report.missing?.join(",")})\n`) : `FAILED: ${result.error}\n`);
    if (!result.ok) console.error(result.stderr || result.stdout);
    samples.push({ run: index + 1, ...result });
  }
  const completed = samples.filter((sample) => sample.ok && sample.report?.complete).map((sample) => sample.report.marks);
  const names = [...new Set(completed.flatMap((marks) => Object.keys(marks)))];
  const summary = Object.fromEntries(names.map((name) => [name, quantiles(completed.map((marks) => marks[name]).filter((value) => typeof value === "number"))]));
  const report = {
    issue: 17,
    kind: "startup-dev",
    seededBindings,
    scope: "pnpm dev with isolated HOME/XDG. Includes electron-vite startup; not comparable to packaged builds or other machines.",
    source: { sha, recordedAt: startedAt, runs, timeoutMs },
    environment: { node: process.version, platform: process.platform, cpu: require("node:os").cpus()[0]?.model },
    completedRuns: completed.length,
    summary,
    samples: samples.map(({ stdout, stderr, ...rest }) => rest),
  };
  if (profile) rmSync(profile, { recursive: true, force: true });
  const runId = startedAt.replace(/[:.]/g, "-");
  const directory = join(process.cwd(), "artifacts", "performance", "issue-17", sha, runId);
  mkdirSync(directory, { recursive: true });
  const output = join(directory, "startup-dev.json");
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, completedRuns: completed.length, runs, summary }, null, 2));
  process.exit(completed.length ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
