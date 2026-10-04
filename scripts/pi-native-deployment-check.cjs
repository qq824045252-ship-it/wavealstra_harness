/** Read-only pre-deployment inspection. Never treats old persisted UI states as a live Pi run. */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const threshold = Number(process.argv[2]);
if (!Number.isFinite(threshold) || threshold <= 0) throw Error('Pass the current application process creation time in milliseconds');
const db = new DatabaseSync('C:/Users/servi/.mybuddy/app.db', { readOnly: true });
try {
  const running = db.prepare("SELECT task_id,execution_id,assistant_message_id,status,started_at FROM task_runtime_context_snapshots WHERE status='running' AND started_at>=? ORDER BY started_at DESC").all(threshold);
  const recent = db.prepare('SELECT id,title,status,updated_at FROM tasks ORDER BY updated_at DESC LIMIT 5').all();
  const leases = db.prepare('SELECT task_id,owner_id,expires_at FROM task_run_leases WHERE expires_at>?').all(Date.now());
  const report = { at: new Date().toISOString(), processStartedAt: threshold, runningSinceProcessStart: running, unexpiredLeases: leases, recentTasks: recent, noRecordedLiveRuns: running.length === 0 && leases.length === 0 };
  fs.writeFileSync('artifacts/pi-native-control/deployment-idle-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.noRecordedLiveRuns ? 0 : 2;
} finally { db.close(); }
