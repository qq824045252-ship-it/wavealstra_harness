import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// One case may fan out several real model requests. Coordinate the case
// processes (including reruns) before they reach the user's shared gateway.
export async function admitLiveCase(alternate = false, original = false) {
  // Long-running native owner panels must leave room for the reference side
  // of a comparison. Both pools share the provider-stream permits below.
  const pool = original ? "reference" : alternate ? "alternate" : "slots";
  const db = new DatabaseSync(join(tmpdir(), "mybuddy-pstack-acceptance-" + pool + ".sqlite"));
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS cases(pid INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS waiting(ticket INTEGER PRIMARY KEY AUTOINCREMENT,pid INTEGER UNIQUE)");
  db.prepare("INSERT OR IGNORE INTO waiting(pid) VALUES(?)").run(process.pid);
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const {pid} of db.prepare("SELECT pid FROM cases UNION SELECT pid FROM waiting").all()) {
        try { process.kill(pid, 0); } catch (e) {
          if (e.code === "ESRCH") { db.prepare("DELETE FROM cases WHERE pid=?").run(pid); db.prepare("DELETE FROM waiting WHERE pid=?").run(pid); }
        }
      }
      const granted = db.prepare("INSERT INTO cases SELECT pid FROM waiting WHERE pid=? AND ticket=(SELECT MIN(ticket) FROM waiting) AND (SELECT COUNT(*) FROM cases)<?").run(process.pid, original || alternate ? 3 : 7).changes;
      if (granted) db.prepare("DELETE FROM waiting WHERE pid=?").run(process.pid);
      db.exec("COMMIT");
      if (granted) break;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    await delay(1000 + Math.random() * 750);
  }
  process.once("exit", () => {
    db.prepare("DELETE FROM cases WHERE pid=?").run(process.pid);
    db.close();
  });
}

// A reviewer fan-out and a foreground turn share the same real upstream
// quota. Hold each permit until the *actual provider stream* settles; a
// slow filesystem operation or an idle human checkpoint consumes no permit.
export function limitLiveRequests(runtime, directory) {
  const capacity = Number(process.env.PSTACK_LIVE_REQUESTS_PER_LANE ?? 4);
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("PSTACK_LIVE_REQUESTS_PER_LANE must be a positive integer.");
  const db = new DatabaseSync(join(directory, "mybuddy-pstack-acceptance-requests.sqlite"));
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, pid INTEGER, lane TEXT, active INTEGER DEFAULT 0)");
  const remove = db.prepare("DELETE FROM requests WHERE id=?");
  const dispatch = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const id = randomUUID();
    const lane = model.provider + "/" + model.id.split("/")[0];
    let held = false;
    const stream = dispatch(model, context, { ...options, onPayload: async (payload, selected) => {
      if (!held) {
        db.prepare("INSERT OR IGNORE INTO requests(id,pid,lane) VALUES(?,?,?)").run(id, process.pid, lane);
        while (!held) {
          options?.signal?.throwIfAborted();
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const {pid} of db.prepare("SELECT DISTINCT pid FROM requests").all()) {
              try { process.kill(pid, 0); } catch (e) { if(e.code === "ESRCH") db.prepare("DELETE FROM requests WHERE pid=?").run(pid); }
            }
            held = !!db.prepare("UPDATE requests SET active=1 WHERE id=? AND id IN (SELECT id FROM requests WHERE lane=? ORDER BY active DESC,rowid LIMIT ?)").run(id,lane,capacity).changes;
            db.exec("COMMIT");
          } catch (e) { db.exec("ROLLBACK"); throw e; }
          if (!held) await delay(400, undefined, {signal: options?.signal});
        }
      }
      return options?.onPayload?.(payload,selected);
    }});
    void stream.result().then(() => remove.run(id), () => remove.run(id));
    return stream;
  };
  process.once("exit", () => { db.prepare("DELETE FROM requests WHERE pid=?").run(process.pid); db.close(); });
}
