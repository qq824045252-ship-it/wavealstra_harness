/**
 * Headless behavioral regression for the dashboard's streaming activity projection.
 * Bundle like the other usage tests (external:better-sqlite3), then run via test-guard.
 * Uses tiny, real AppDatabase disk fixtures, never the user's profile or a product build.
 * The wide oracle replaces only the new projection, not the dashboard implementation.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { UsageQueryRow, UsageStatsService as Service } from "../src/main/usage/UsageStatsService";
import type { AppDatabase as App } from "../src/main/db/AppDatabase";

const root = mkdtempSync(join(tmpdir(), "udp-"));
const environment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TZ: process.env.TZ };
const realNow = Date.now;
let comparisons = 0;
let fixtures = 0;
// Load product modules only after isolation, including any import-time path discovery.
process.env.HOME = process.env.USERPROFILE = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });
const { AppDatabase } = require("../src/main/db/AppDatabase") as typeof import("../src/main/db/AppDatabase");
const { UsageStatsService } = require("../src/main/usage/UsageStatsService") as typeof import("../src/main/usage/UsageStatsService");
const { rangeStartMs, localDayKey } = require("../src/shared/usage-stats") as typeof import("../src/shared/usage-stats");

type FullRow = UsageQueryRow & { inputKnown: number | null; outputKnown: number | null;
  cacheReadKnown: number | null; cacheWriteKnown: number | null; costKnown: number | null };
type ProjectionAccess = { activityRows(since: number): Iterable<unknown> };
const ranges = [1, 7, 30, 370, 371, 372, 0, -3, 0.5, 7.5];
function fullRow(entryId: string, ts: number, patch: Partial<FullRow> = {}): FullRow {
  return { entryId, taskId: "task-a", sessionFile: null, sourceKind: "main", sourceDetail: "pi-durable",
    provider: "provider-a", model: "model-a", responseModel: "response-a", ts,
    inputTokens: 10, outputTokens: 20, cacheRead: 30, cacheWrite: 40,
    cacheWrite1h: 3, reasoningTokens: 4, totalTokens: 999, costTotal: 0.1,
    stopReason: "stop", errorMessage: null, ttftMs: 11, decodeMs: 22,
    generationTps: 1.25, modelWallMs: 33, turnIndex: 0, userTurn: 1,
    responseId: `response-${entryId}`, backfilled: 1,
    inputKnown: null, outputKnown: null, cacheReadKnown: null, cacheWriteKnown: null, costKnown: null,
    ...patch };
}
const columns: Array<[string, keyof FullRow]> = [
  ["entry_id", "entryId"], ["task_id", "taskId"], ["session_file", "sessionFile"],
  ["source_kind", "sourceKind"], ["source_detail", "sourceDetail"], ["provider", "provider"],
  ["model", "model"], ["response_model", "responseModel"], ["ts", "ts"],
  ["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"], ["cache_write_1h", "cacheWrite1h"], ["reasoning_tokens", "reasoningTokens"],
  ["total_tokens", "totalTokens"], ["cost_total", "costTotal"], ["stop_reason", "stopReason"],
  ["error_message", "errorMessage"], ["ttft_ms", "ttftMs"], ["decode_ms", "decodeMs"],
  ["generation_tps", "generationTps"], ["model_wall_ms", "modelWallMs"],
  ["turn_index", "turnIndex"], ["user_turn", "userTurn"], ["response_id", "responseId"], ["backfilled", "backfilled"],
];
function insert(db: Database.Database, row: FullRow, coverage = false): void {
  db.prepare(`INSERT INTO usage_events (${columns.map(([column]) => column).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map(([, key]) => row[key]));
  if (coverage) db.prepare("INSERT INTO usage_event_coverage VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.entryId, row.inputKnown, row.outputKnown, row.cacheReadKnown, row.cacheWriteKnown, row.costKnown);
}
function withDatabase(fn: (app: App, service: Service, path: string) => void): void {
  const path = join(root, `${fixtures++}.db`);
  const app = new AppDatabase(path);
  try { fn(app, new UsageStatsService(app.connection), path); }
  finally { if (app.connection.open) app.close(); }
}
function compare(service: Service, range: number, label: string): ReturnType<Service["dashboard"]> {
  const actual = service.dashboard(range);
  const access = service as unknown as ProjectionAccess;
  const original = access.activityRows;
  let expected: ReturnType<Service["dashboard"]>;
  try {
    access.activityRows = since => service.queryRows({ since });
    expected = service.dashboard(range);
  } finally { access.activityRows = original; }
  assert.deepStrictEqual(actual, expected, `${label}: every dashboard field, range=${range}`);
  comparisons++;
  return actual;
}
function skill(name: string, timestamp = "2000-01-01T00:00:00Z"): string {
  return JSON.stringify({ type: "message", timestamp, message: { role: "user", content: `/${name}` } });
}

try {
  Date.now = () => new Date("2024-03-11T12:00:00Z").getTime();
  withDatabase((app, service) => {
    // Explicit expectations independent of normalizeUsageRow: every returned field,
    // raw mismatched totals, unknown components, real zero and cost fallback.
    const t = Date.now();
    const known = { inputKnown: 1, outputKnown: 1, cacheReadKnown: 1, cacheWriteKnown: 1, costKnown: 1 };
    const all = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };
    const none = { input: false, output: false, cacheRead: false, cacheWrite: false, cost: false };
    const cases: Array<{ raw: FullRow; coverage: boolean; normalized: Partial<FullRow> }> = [
      { raw: fullRow("legacy-positive", t), coverage: false, normalized: { known: all } },
      { raw: fullRow("legacy-zero", t + 1, { totalTokens: 0 }), coverage: false,
        normalized: { known: none, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0, totalTokens: 0 } },
      { raw: fullRow("known-zero", t + 2, { ...known, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 }), coverage: true, normalized: { known: all } },
      { raw: fullRow("partial", t + 3, { ...known, inputKnown: 0, cacheWriteKnown: 0, costKnown: 0 }), coverage: true,
        normalized: { known: { ...all, input: false, cacheWrite: false }, inputTokens: 0, cacheWrite: 0, totalTokens: 50 } },
      { raw: fullRow("unknown-zero", t + 4, { ...known, inputKnown: 0, outputKnown: 0, cacheReadKnown: 0, cacheWriteKnown: 0, costKnown: 0, totalTokens: 0 }), coverage: true,
        normalized: { known: none, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 } },
      { raw: fullRow("cost-raw-positive", t + 5, { ...known, costKnown: 0, totalTokens: 777 }), coverage: true, normalized: { known: all } },
      { raw: fullRow("nullable-metadata", t + 6, { taskId: null, provider: null, model: null, responseModel: null, sourceDetail: null, cacheWrite1h: null, reasoningTokens: null, ttftMs: null, decodeMs: null, generationTps: null, modelWallMs: null, turnIndex: null, userTurn: null, responseId: null, stopReason: null, backfilled: 0 }), coverage: false, normalized: { known: all } },
    ];
    // Reverse inserts distinguish timestamp order from insertion order.
    for (const c of [...cases].reverse()) insert(app.connection, c.raw, c.coverage);
    assert.deepStrictEqual(service.queryRows({}), cases.map(c => ({ ...c.raw, ...c.normalized })), "full normalized queryRows DTO");
    assert.deepStrictEqual(service.queryRows({ since: t + 2, until: t + 3, sourceKinds: ["main"] }), cases.slice(2, 4).map(c => ({ ...c.raw, ...c.normalized })), "inclusive filters and ordering");
    assert.deepStrictEqual(service.queryRows({ sourceKinds: ["missing"] }), []);
    for (const range of ranges) compare(service, range, "normalization");
  });
  console.log("PASS independent full queryRows normalization and filtering");

  for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    process.env.TZ = zone;
    for (const date of ["2024-03-11", "2024-11-04", "2024-02-29"]) {
      const now = new Date(`${date}T12:00:00`).getTime();
      Date.now = () => now;
      withDatabase((app, service) => {
        for (const range of ranges) compare(service, range, `${zone}/${date}/empty`);
        const db = app.connection;
        const session = join(root, `session-${fixtures}.jsonl`);
        const coldSession = join(root, `cold-${fixtures}.jsonl`);
        writeFileSync(session, [skill("before-window"), skill("popular"), skill("popular"),
          ...Array.from({ length: 23 }, (_, i) => skill(`skill-${String(i).padStart(2, "0")}`)), "{broken", "null"].join("\n"));
        writeFileSync(coldSession, skill("heat-only-excluded"));
        const kinds = ["main", "btw", "subagent", "auxiliary", "compaction", "toolresult", "unknown"];
        for (let i = 0; i < kinds.length; i++) insert(db, fullRow(`kind-${i}`, now - 60_000 + i, {
          sourceKind: kinds[i], sessionFile: i % 2 ? null : session, taskId: `task-${i % 3}`,
          provider: i % 2 ? "provider-b" : "provider-a", model: `model-${i % 3}`,
          turnIndex: i, userTurn: i % 2 + 1, costTotal: i % 2 ? 0.2 : 0.1,
          stopReason: i === 1 ? "error" : "stop", errorMessage: i === 2 ? "fixture-error" : null,
        }));
        insert(db, fullRow("disposed", now - 100, { stopReason: "disposed", sessionFile: session }));
        insert(db, fullRow("missing-file", now - 99, { sessionFile: join(root, "missing.jsonl"), taskId: null, userTurn: null }));
        insert(db, fullRow("future-today", now + 60_000, { sessionFile: session }));
        insert(db, fullRow("future-date", rangeStartMs(1, now) + 3 * 86400_000, { sessionFile: session }));
        insert(db, fullRow("heat-only", rangeStartMs(31, now), { sessionFile: coldSession }));
        // Every relevant range boundary, including yesterday for current streak.
        for (const days of [1, 2, 3, 7, 30, 370, 371, 372]) {
          const boundary = rangeStartMs(days, now);
          for (const delta of [-1, 0, 1]) insert(db, fullRow(`boundary-${days}-${delta}`, boundary + delta, {
            sessionFile: null, userTurn: days, costTotal: delta === -1 ? 1e16 : delta === 0 ? -1e16 : 0.1,
            inputKnown: 0, outputKnown: 1, cacheReadKnown: 1, cacheWriteKnown: 0, costKnown: 0,
          }), true);
        }
        // Same timestamp retains SQLite's existing tie order; exact floating-point
        // comparisons detect any changed accumulation order without a new tie-break.
        for (const [i, cost] of [1e16, 1, -1e16].entries()) {
          insert(db, fullRow(`tie-${i}`, now - 123, { costTotal: cost }));
        }
        const today = compare(service, 1, `${zone}/${date}/populated`);
        assert.equal(today.skills.length, 20, "skill top20 limit");
        assert.deepStrictEqual(today.skills.slice(0, 2), [{ name: "popular", count: 2 }, { name: "before-window", count: 1 }], "whole-file old skill, duplicate file dedup, count/name ordering");
        assert(!today.skills.some(s => s.name === "heat-only-excluded"), "heat-only session does not leak into range skills");
        assert.equal(today.skills.at(-1)?.name, "skill-17", "top20 tie ordering");
        assert(today.currentStreakDays >= 3, "consecutive local days form current streak");
        assert.equal(today.days.at(-1)?.date, localDayKey(now), "future dates do not extend heatmap");
        for (const range of ranges) compare(service, range, `${zone}/${date}/populated`);
        // Freshness on the same instance: INSERT, UPDATE, coverage change, DELETE,
        // and a JSONL edit must all be visible without any cache invalidation API.
        const before = service.dashboard(1);
        insert(db, fullRow("fresh", now, { totalTokens: 12345, sessionFile: session }));
        const added = compare(service, 1, "insert freshness");
        assert.equal(added.totalTokens - before.totalTokens, 12345);
        db.prepare("UPDATE usage_events SET total_tokens=54321 WHERE entry_id='fresh'").run();
        assert.equal(compare(service, 1, "update freshness").totalTokens - before.totalTokens, 54321);
        db.prepare("INSERT INTO usage_event_coverage VALUES ('fresh', 0, 1, 0, 1, 0)").run();
        assert.equal(compare(service, 1, "coverage freshness").totalTokens - before.totalTokens, 60);
        db.prepare("UPDATE usage_event_coverage SET input_known=1,cache_read_known=1 WHERE entry_id='fresh'").run();
        assert.equal(compare(service, 1, "coverage update freshness").totalTokens - before.totalTokens, 54321);
        db.prepare("DELETE FROM usage_events WHERE entry_id='fresh'").run();
        assert.deepStrictEqual(compare(service, 1, "delete freshness"), before);
        writeFileSync(session, skill("edited-file"));
        assert.deepStrictEqual(compare(service, 1, "JSONL freshness").skills, [{ name: "edited-file", count: 1 }]);
        // Abrupt iterator termination must release SQLite statement as well as full consumption.
        const access = service as unknown as ProjectionAccess;
        const iterator = access.activityRows(rangeStartMs(371, now))[Symbol.iterator]();
        assert.equal(iterator.next().done, false);
        assert.equal(typeof iterator.return, "function");
        iterator.return!();
        db.prepare("UPDATE usage_events SET model=model WHERE entry_id='kind-0'").run();
        compare(service, 1, "iterator explicit return releases statement");
        const consumerError = new Error("intentional consumer failure");
        assert.throws(() => {
          for (const _row of access.activityRows(rangeStartMs(371, now))) throw consumerError;
        }, error => error === consumerError);
        db.prepare("UPDATE usage_events SET model=model WHERE entry_id='kind-0'").run();
        compare(service, 1, "throwing iterator consumer releases statement");
        db.exec("CREATE TABLE iterator_release_probe (id INTEGER); DROP TABLE iterator_release_probe");
        // withDatabase closes this same connection; an active statement would fail close/DDL.
      });
    }
    console.log(`PASS ${zone}: leap day, spring/fall DST; empty/populated/ranges/freshness/skills/iterator release`);
  }

  withDatabase((app, _service, path) => {
    const now = Date.now();
    insert(app.connection, fullRow("no-table-positive", now));
    insert(app.connection, fullRow("no-table-zero", now + 1, { totalTokens: 0 }));
    app.connection.exec("DROP TABLE usage_event_coverage");
    app.close();
    const readOnly = new Database(path, { readonly: true, fileMustExist: true });
    try {
      assert.equal((readOnly.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='usage_event_coverage'").get() as { n: number }).n, 0);
      assert.throws(() => readOnly.exec("CREATE TABLE usage_event_coverage (entry_id TEXT)"), /readonly/i, "actual DDL rejection, not a mocked coverage flag");
      const service = new UsageStatsService(readOnly);
      const rows = service.queryRows({});
      assert.deepStrictEqual(rows, [
        { ...fullRow("no-table-positive", now), known: { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true } },
        { ...fullRow("no-table-zero", now + 1, { totalTokens: 0 }), known: { input: false, output: false, cacheRead: false, cacheWrite: false, cost: false }, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 },
      ], "full DTO without coverage table");
      for (const range of ranges) compare(service, range, "coverage table absent/readonly");
    } finally { readOnly.close(); }
  });
  console.log(`PASS coverage table unavailable; ${comparisons} whole-dashboard comparisons across ${fixtures} real disk fixtures`);
} finally {
  Date.now = realNow;
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
