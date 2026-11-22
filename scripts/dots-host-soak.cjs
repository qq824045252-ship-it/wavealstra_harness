const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const option = process.argv.slice(2).find(arg => arg.startsWith("--soak-hours="));
const hours = option === undefined ? 0 : Number(option.slice("--soak-hours=".length));
if (option && (!Number.isFinite(hours) || hours <= 0 || !Number.isSafeInteger(Math.ceil(hours * 3600000)))) {
  throw Error("--soak-hours requires a positive number of hours");
}
const duration = Math.ceil(hours * 3600000);
const interval = hours >= 2 ? 3600000 : duration >= 300000 ? 60000 : 5000;
const jobId = "resident-soak-check";

const probes = ["disconnect", "model-error", "recovery"];
const faultEvidence = [];
function fixtureModel(request) {
  const current = JSON.stringify(request.messages.findLast(message => message.role === "user")?.content);
  const probe = probes.find(name => current?.includes("resident-probe-" + name));
  if (!probe) return "OK";
  const at = Date.now();
  if (probe === "disconnect" && !faultEvidence.some(item => item.action === "socket-reset")) {
    faultEvidence.push({at, action:"socket-reset"});
    return { fixtureFault:"disconnect" };
  }
  if (probe === "model-error") {
    faultEvidence.push({at, action:"model-http-400"});
    return { fixtureFault:"model-error", message:"resident-fixture-model-rejected" };
  }
  faultEvidence.push({at, action:probe + "-ok"});
  return "OK";
}

async function schedule(evaluate, taskId) {
  if (!duration) return;
  const at = Date.now();
  const job = {
    id: jobId, name: "Dots 宿主稳定性检查", prompt: "请回复 OK", welcomeMode: "general",
    sourceTaskId: taskId, target: { kind: "task", taskId }, restartPolicy: "resume", missedRuns: "coalesce",
    scheduleType: "every", scheduleExpr: interval / 1000 + "s", timezone: "UTC", enabled: true, createdAt: at, updatedAt: at,
  };
  await evaluate("window.api.cron.upsert(" + JSON.stringify(job) + ")");
  for (const [index, probe] of probes.entries()) {
    const id = "resident-probe-" + probe;
    const once = { ...job, id, name:id, prompt:id, target:{kind:"new-task"}, missedRuns:"skip", scheduleType:"at",
      scheduleExpr:new Date(at + 15000 + index * 10000).toISOString() };
    await evaluate("window.api.cron.upsert(" + JSON.stringify(once) + ")");
  }
}

async function observe({ home, out, report, db, owner, pid, taskId, health }) {
  if (!duration) return;
  const file = path.join(out, "resident-soak.jsonl");
  console.log("Dots resident soak evidence: " + file);
  const started = Date.now(), startClock = performance.now(), token = owner().token;
  const cadence = Math.min(60000, interval), sevenDays = 7 * 24 * 3600000;
  const timer = db.prepare(`SELECT MAX(CASE WHEN status='success' AND task_id=? THEN finished_at END) AS lastSuccess,
    SUM(CASE WHEN status='success' AND task_id=? THEN 1 ELSE 0 END) AS successfulRuns,
    SUM(CASE WHEN status IN ('error','skipped') OR status='success' AND task_id IS NOT ? THEN 1 ELSE 0 END) AS failedRuns
    FROM cron_runs WHERE job_id=?`);
  const probeRun = db.prepare("SELECT status,error,task_id,finished_at FROM cron_runs WHERE job_id=? ORDER BY started_at DESC LIMIT 1");
  let previous = started, samples = 0;
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    for (;;) {
      const now = Date.now(), elapsed = now - started, monotonic = Math.round(performance.now() - startClock);
      const lease = owner();
      const state = health();
      const hostResponsive = !state.createdWindow && state.exitCode === null && state.signalCode === null && state.heartbeatAgeMs < 15000;
      const sample = { at: new Date(now).toISOString(), elapsedMs: elapsed, monotonicMs: monotonic,
        intervalMs: now - previous, pid: lease.pid, sameOwner: lease.token === token, hostResponsive, ...state, ...timer.get(taskId, taskId, taskId, jobId) };
      appendFileSync(file, JSON.stringify(sample) + "\n");
      samples++;
      assert.equal(sample.pid, pid);
      assert(sample.sameOwner && sample.hostResponsive, "resident lost ownership or its main event loop stalled");
      assert(sample.intervalMs >= 0 && sample.intervalMs < 180000 && Math.abs(elapsed - monotonic) < 180000, "observed clock discontinuity or a gap longer than three minutes");
      assert.equal(Number(sample.failedRuns), 0, "a scheduled native Dots run failed or went to another task");
      assert(now - Math.max(started, sample.lastSuccess ?? 0) < interval + 120000, "native Dots timer stopped delivering");
      if (!report.faultProbes) {
        const runs = Object.fromEntries(probes.map(name => [name, probeRun.get("resident-probe-" + name)]));
        const complete = Object.values(runs).every(run => run?.finished_at);
        if (complete || elapsed > 120000) {
          const evidence = {faultEvidence, runs};
          appendFileSync(file, JSON.stringify(evidence) + "\n");
          assert(faultEvidence.some(event => event.action === "socket-reset"));
          assert(faultEvidence.some(event => event.action === "model-http-400"));
          assert(faultEvidence.some(event => event.action === "recovery-ok"));
          assert(faultEvidence.some(event => event.action === "disconnect-ok"), "transport never retried the interrupted request");
          assert.equal(runs.disconnect?.status, "success");
          assert.equal(runs["model-error"]?.status, "error", JSON.stringify(evidence));
          assert.match(runs["model-error"].error, /resident-fixture-model-rejected/);
          assert.equal(runs.recovery?.status, "success");
          assert(runs.recovery.finished_at >= runs["model-error"].finished_at);
          assert.equal(new Set(Object.values(runs).map(run => run.task_id)).size, probes.length);
          report.faultProbes = evidence;
        }
      }
      const normalAfterRecovery = report.faultProbes && sample.lastSuccess > report.faultProbes.runs.recovery.finished_at;
      if (Math.min(elapsed, monotonic) >= duration && normalAfterRecovery) {
        report.soak = { hours, elapsedMs: elapsed, monotonicMs: monotonic, samples, successfulRuns: sample.successfulRuns,
          isolatedHome: home, result: elapsed >= sevenDays && monotonic >= sevenDays ? "seven-day run completed" : "short smoke completed" };
        return;
      }
      previous = now;
      await delay(Math.max(1, Math.min(cadence, elapsed >= duration ? cadence : duration - Math.min(elapsed, monotonic))), undefined, { signal: stop.signal });
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

module.exports = { enabled: duration > 0, schedule, observe, fixtureModel };
