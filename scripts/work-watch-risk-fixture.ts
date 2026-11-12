import assert from "node:assert/strict";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { WorkService } from "../src/main/agent/work/WorkService";
import type { WorkWatchSupervision } from "../src/main/agent/work/WorkWatchSupervision";
import type { WorkActor } from "../src/shared/bot-work";

export function verifyWatchRiskQueries(db: AppDatabase, works: WorkService, supervisor: WorkWatchSupervision, actor: WorkActor) {
  const result = works.createWork(actor, { operationId: "risk-query-scale", title: "risk query scale", inputSnapshotId: "risk-query-scale" });
  assert(result.ok);
  const work = result.work;
  const template = works.repo.getBinding("round1");
  assert(template);
  const current = { ...template, bindingId: "risk-query-current", taskId: "risk-query-current", operationId: "risk-query-current", workId: work.workId,
    intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch };
  works.repo.insertBinding(current);
  let inserted = 0;
  const counts: number[] = [];
  for (const count of [100, 1000, 10000]) {
    works.transaction(() => {
      for (; inserted < count; inserted++) {
        const id = `risk-query-${inserted}`;
        works.repo.insertBinding({ ...current, bindingId: id, taskId: id, operationId: id });
      }
    });
    const prepare = db.connection.prepare.bind(db.connection);
    const descriptor = Object.getOwnPropertyDescriptor(db.connection, "prepare");
    const queries: string[] = [];
    Object.defineProperty(db.connection, "prepare", { configurable: true, value: (sql: string) => { queries.push(sql); return prepare(sql); } });
    try {
      const risks = supervisor["executionRisks"](current);
      assert.deepEqual(risks.items, []);
      assert.equal(risks.omittedRiskCount, 0);
    } finally {
      if (descriptor) Object.defineProperty(db.connection, "prepare", descriptor);
      else Reflect.deleteProperty(db.connection, "prepare");
    }
    assert(!queries.some(sql => /metrics/i.test(sql)), "risk-only reads must not fetch metrics");
    counts.push(queries.length);
  }
  assert.deepEqual(counts, [3, 3, 3], "completed history cannot increase risk-query count");
  const retired = { ...current, bindingId: "retired-risk", taskId: "retired-risk", operationId: "retired-risk", status: "invalidated" as const, invalidatedAt: 1, intentRevision: work.intentRevision - 1 };
  works.repo.insertBinding(retired);
  works.repo.insertAdmission({ admissionId: "old-unknown", workId: work.workId, bindingId: retired.bindingId,
    operationId: "old-write", actionKind: "write", state: "unknown", intentRevision: retired.intentRevision, ownerEpoch: retired.ownerEpoch, admittedAt: 1 });
  works.repo.insertBinding({ ...current, bindingId: "running-risk", taskId: "running-risk", operationId: "running-risk", status: "running" });
  const risks = supervisor["executionRisks"](current);
  assert.deepEqual(risks.items.map(item => item.riskId), ["old-unknown", "execution:running-risk"]);
  assert.equal(risks.items[0].retired, true);
  assert.equal(risks.items[0].invalidatedAt, 1);
  assert.equal(risks.items[1].retired, false);
  works.repo.updateAdmissionState("old-unknown", "released", 2);
  const checkedAgain = supervisor["executionRisks"](current);
  assert.deepEqual(checkedAgain.items.map(item => item.riskId), ["execution:running-risk"]);
  assert.notEqual(checkedAgain.fingerprint, risks.fingerprint);
  console.log("PASS Watch risk queries: 100/1,000/10,000 completed bindings each use 3 SQL queries and 0 metrics reads; old unknown effects and fact rechecks retained");
}
