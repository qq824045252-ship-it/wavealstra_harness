import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";

const results: string[] = [];
function check(name: string, fn: () => void): void { fn(); results.push(`PASS ${name}`); }
function discardedBackups(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).filter(name => name.startsWith(`${basename(dbPath)}.discarded-`)).sort();
}
function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return Number(db.pragma("user_version", { simple: true })); }
  finally { db.close(); }
}
function createIncompatibleDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('discard-me');");
    db.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION - 1}`);
  } finally { db.close(); }
}
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [], original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.warn = original; }
  return warnings;
}
function assertEmptyCurrent(dbPath: string): void {
  const appDb = new AppDatabase(dbPath);
  try {
    assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(appDb.listTasks(), []);
    assert.equal(appDb.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sentinel'").get(), undefined);
    appDb.upsertTask({ id: "fresh-task", title: "usable current database", updatedAt: 1 });
    assert.equal(appDb.getTask("fresh-task")?.title, "usable current database");
  } finally { appDb.close(); }
}

const tempBase = resolve(tmpdir());
const root = mkdtempSync(join(tempBase, "mybuddy-db-discard-"));
try {
  check("Confirmed incompatible schema is deleted and rebuilt without a backup", () => {
    const dbPath = join(root, "incompatible.db");
    createIncompatibleDatabase(dbPath);
    const warnings = captureWarnings(() => assertEmptyCurrent(dbPath));
    assert.deepEqual(discardedBackups(dbPath), []);
    assert(!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`));
    assert.equal(readUserVersion(dbPath), CURRENT_DATABASE_SCHEMA_VERSION);
    assert(warnings.some(message => message.includes("reset: deleted") && message.includes(dbPath)
      && message.includes(`v${CURRENT_DATABASE_SCHEMA_VERSION - 1}`)));
  });

  check("Incompatible WAL and SHM are removed before a new database can replay them", () => {
    const stagePath = join(root, "wal-stage.db"), dbPath = join(root, "wal-target.db");
    const stage = new Database(stagePath);
    try {
      stage.pragma("journal_mode = WAL");
      stage.pragma("wal_autocheckpoint = 0");
      stage.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('uncheckpointed-old-row');");
      stage.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION - 1}`);
      for (const suffix of ["", "-wal", "-shm"]) copyFileSync(`${stagePath}${suffix}`, `${dbPath}${suffix}`);
      assert(statSync(`${dbPath}-wal`).size > 0);
      assert(existsSync(`${dbPath}-shm`));
    } finally { stage.close(); }
    assert.equal(readUserVersion(dbPath), CURRENT_DATABASE_SCHEMA_VERSION - 1, "probe sees the actual version stored in WAL");
    assertEmptyCurrent(dbPath);
    assert.deepEqual(discardedBackups(dbPath), []);
    assert(!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`), "no old sidecar survives the rebuild");
  });

  check("Current-schema tasks and unrelated current tables survive reopen", () => {
    const dbPath = join(root, "current.db");
    const first = new AppDatabase(dbPath);
    first.upsertTask({ id: "keep-task", title: "keep current data", updatedAt: 7 });
    first.connection.exec("CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel VALUES ('keep-current-row');");
    first.close();
    const warnings = captureWarnings(() => {
      const reopened = new AppDatabase(dbPath);
      try {
        assert.equal(reopened.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
        assert.equal(reopened.getTask("keep-task")?.title, "keep current data");
        assert.deepEqual(reopened.connection.prepare("SELECT value FROM sentinel").pluck().all(), ["keep-current-row"]);
      } finally { reopened.close(); }
    });
    assert(!warnings.some(message => message.includes("incompatible database")));
    assert.deepEqual(discardedBackups(dbPath), []);
  });

  check("Unreadable schema is not guessed to be old and its bytes are retained", () => {
    const dbPath = join(root, "unknown.db");
    const original = Buffer.from("not-a-sqlite-database");
    writeFileSync(dbPath, original);
    assert.throws(() => new AppDatabase(dbPath), /not a database|file is not a database|SQLITE_NOTADB/i);
    assert.deepEqual(readFileSync(dbPath), original);
    assert.deepEqual(discardedBackups(dbPath), []);
  });

  check("Sidecar deletion failure stops startup before replacing the main database", () => {
    const dbPath = join(root, "blocked-delete.db");
    createIncompatibleDatabase(dbPath);
    const original = readFileSync(dbPath);
    const blockedSidecar = `${dbPath}-shm`;
    mkdirSync(blockedSidecar);
    writeFileSync(join(blockedSidecar, "unrelated-file"), "keep me");
    assert.throws(() => new AppDatabase(dbPath), /无法删除不兼容数据库.*未重建/);
    assert.deepEqual(readFileSync(dbPath), original);
    assert.equal(readUserVersion(dbPath), CURRENT_DATABASE_SCHEMA_VERSION - 1);
    assert.equal(readFileSync(join(blockedSidecar, "unrelated-file"), "utf8"), "keep me", "deletion never recurses into a directory");
    assert.deepEqual(discardedBackups(dbPath), []);
  });

  check("Missing main file cannot replay orphan sidecars into a fresh database", () => {
    const dbPath = join(root, "orphaned.db");
    writeFileSync(`${dbPath}-wal`, "orphaned WAL bytes");
    writeFileSync(`${dbPath}-shm`, "orphaned SHM bytes");
    writeFileSync(`${dbPath}-journal`, "orphaned rollback journal bytes");
    assertEmptyCurrent(dbPath);
    assert.deepEqual(discardedBackups(dbPath), []);
    assert(!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`));
    assert(!existsSync(`${dbPath}-journal`));
  });

  check("Reset touches only the named database and leaves existing backup files alone", () => {
    const dbPath = join(root, "scoped.db"), retained = `${dbPath}.discarded-existing`;
    createIncompatibleDatabase(dbPath);
    writeFileSync(retained, "unrelated prior backup");
    assertEmptyCurrent(dbPath);
    assert.equal(readFileSync(retained, "utf8"), "unrelated prior backup");
    assert.deepEqual(discardedBackups(dbPath), [basename(retained)]);
  });

  check("Fresh and in-memory databases initialize at the current schema", () => {
    const dbPath = join(root, "fresh.db");
    assertEmptyCurrent(dbPath);
    assert.deepEqual(discardedBackups(dbPath), []);
    const memory = new AppDatabase(":memory:");
    try { assert.equal(memory.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION); }
    finally { memory.close(); }
  });

  console.log(`db-schema-discard-test: ${results.length} checks PASS`);
  for (const result of results) console.log(`  ${result}`);
} finally {
  assert(resolve(root).startsWith(join(tempBase, "mybuddy-db-discard-")));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
