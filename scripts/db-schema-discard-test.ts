/**
 * 回归测试：不兼容数据库（user_version 与 CURRENT_DATABASE_SCHEMA_VERSION 不一致）
 * 必须「备份后重建」，绝不静默删除用户数据。
 *
 * 覆盖：
 *   - 普通旧库：db 改名为 `.discarded-<UTC 时间戳>`，备份内容可读、重建库可用；
 *   - WAL 旧库：-wal/-shm 与主库一起备份，备份仍能重放出未 checkpoint 的 WAL 数据；
 *   - 损坏库：原文件被备份（字节不变），不是被删掉；
 *   - 当前版本库：不产生备份（不误伤正常库）；
 *   - 同一路径二次降级：已有备份不被覆盖；
 *   - rename 失败（只读目录，POSIX 非 root）：抛错且原库仍然完好。
 *
 * 运行：esbuild 打包后由 test-guard 执行（见报告里建议的 package.json test 脚本）。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";

const results: string[] = [];
function check(name: string, fn: () => void): void {
  fn();
  results.push(`PASS ${name}`);
}

function discardedBackups(dbPath: string): string[] {
  const prefix = `${basename(dbPath)}.discarded-`;
  return readdirSync(dirname(dbPath))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(dbPath), name))
    .sort();
}

function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return Number(db.pragma("user_version", { simple: true })); }
  finally { db.close(); }
}

function readSentinelValues(dbPath: string): string[] {
  const db = new Database(dbPath);
  try { return (db.prepare("SELECT value FROM sentinel ORDER BY rowid").all() as Array<{ value: string }>).map((row) => row.value); }
  finally { db.close(); }
}

function createLegacyDatabase(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL);");
    db.exec("INSERT INTO sentinel VALUES ('row-1'); INSERT INTO sentinel VALUES ('row-2');");
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function captureWarnings(fn: () => void): string[] {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { messages.push(args.map((arg) => String(arg)).join(" ")); };
  try { fn(); }
  finally { console.warn = originalWarn; }
  return messages;
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-db-discard-"));
const outdatedVersion = CURRENT_DATABASE_SCHEMA_VERSION - 1;
try {
  check("Incompatible database is renamed to a .discarded backup, then rebuilt", () => {
    const dbPath = join(root, "plain.db");
    createLegacyDatabase(dbPath, outdatedVersion);

    const warnings: string[] = [];
    const appDb = (() => {
      let opened!: AppDatabase;
      warnings.push(...captureWarnings(() => { opened = new AppDatabase(dbPath); }));
      return opened;
    })();
    try {
      assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "rebuilt database reports the current schema version");
      assert.equal(appDb.listTasks().length, 0, "rebuilt database is empty");
      assert.equal(
        appDb.connection.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='sentinel'").get(),
        undefined,
        "rebuilt database does not keep the incompatible table",
      );
    } finally {
      appDb.close();
    }

    assert.ok(existsSync(dbPath), "original database path was recreated");
    assert.equal(readFileSync(dbPath).subarray(0, 15).toString("utf8"), "SQLite format 3", "recreated database has a SQLite header");

    const backups = discardedBackups(dbPath);
    assert.equal(backups.length, 1, "exactly one backup file is produced");
    const stamp = basename(backups[0]).slice(`${basename(dbPath)}.discarded-`.length);
    assert.match(stamp, /^\d{8}T\d{9}Z(-\d+)?$/, `backup name carries a UTC timestamp: ${stamp}`);
    assert.equal(readUserVersion(backups[0]), outdatedVersion, "backup keeps the old user_version");
    assert.deepEqual(readSentinelValues(backups[0]), ["row-1", "row-2"], "backup preserves the discarded rows");

    const resetWarning = warnings.find((message) => message.includes("incompatible database") && message.includes(backups[0]));
    assert.ok(resetWarning, `warning names the backup path: ${warnings.join(" | ")}`);
    assert.ok(resetWarning.includes(`v${outdatedVersion}`), "warning names the discarded version");
    assert.ok(resetWarning.includes(`v${CURRENT_DATABASE_SCHEMA_VERSION}`), "warning names the current version");
  });

  check("WAL and SHM sidecars are backed up together and the WAL data is still readable", () => {
    const stageDir = join(root, "wal-stage");
    mkdirSync(stageDir);
    const stagePath = join(stageDir, "stage.db");
    const stage = new Database(stagePath);
    stage.pragma("journal_mode = WAL");
    stage.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('before-wal');");
    stage.pragma(`user_version = ${outdatedVersion}`);
    stage.exec("INSERT INTO sentinel VALUES ('inside-wal');");
    try {
      const walDir = join(root, "wal");
      mkdirSync(walDir);
      const dbPath = join(walDir, "legacy.db");
      for (const suffix of ["", "-wal", "-shm"]) {
        const source = `${stagePath}${suffix}`;
        if (existsSync(source)) copyFileSync(source, `${dbPath}${suffix}`);
      }
      assert.ok(existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0, "fixture has a non-empty -wal file");
      assert.ok(existsSync(`${dbPath}-shm`), "fixture has a -shm file");
    } finally {
      stage.close();
    }

    const dbPath = join(root, "wal", "legacy.db");
    const appDb = new AppDatabase(dbPath);
    try {
      assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "rebuilt WAL database reports the current schema version");
      assert.equal(appDb.listTasks().length, 0, "rebuilt WAL database is empty");
    } finally {
      appDb.close();
    }

    const backups = discardedBackups(dbPath);
    assert.equal(backups.length, 3, "database, WAL and SHM are all backed up");
    const backupDb = backups.find((backup) => /^\d{8}T\d{9}Z(-\d+)?$/.test(basename(backup).slice(`${basename(dbPath)}.discarded-`.length)));
    assert.ok(backupDb, "one backup is the primary database file");
    assert.ok(backups.includes(`${backupDb}-wal`), "WAL is backed up next to the primary backup");
    assert.ok(backups.includes(`${backupDb}-shm`), "SHM is backed up next to the primary backup");
    assert.equal(readUserVersion(backupDb), outdatedVersion, "WAL backup keeps the old user_version");
    assert.deepEqual(readSentinelValues(backupDb), ["before-wal", "inside-wal"], "backup replays the uncheckpointed WAL rows");
  });

  check("Corrupt database file is backed up byte-for-byte instead of deleted", () => {
    const dbPath = join(root, "corrupt.db");
    const bytes = "not-a-sqlite-database";
    writeFileSync(dbPath, bytes);
    assert.equal(existsSync(dbPath), true, "fixture exists");

    const appDb = new AppDatabase(dbPath);
    try {
      assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "corrupt database was replaced by a current-schema database");
    } finally {
      appDb.close();
    }

    const backups = discardedBackups(dbPath);
    assert.equal(backups.length, 1, "corrupt file is kept as one backup");
    assert.equal(readFileSync(backups[0], "utf8"), bytes, "backup keeps the original corrupt bytes");
    assert.equal(readFileSync(dbPath).subarray(0, 15).toString("utf8"), "SQLite format 3", "original path now holds a real SQLite database");
  });

  check("A current-schema database is never backed up or reset", () => {
    const dbPath = join(root, "current.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('keep-me');");
    db.pragma(`user_version = ${CURRENT_DATABASE_SCHEMA_VERSION}`);
    db.close();

    const appDb = new AppDatabase(dbPath);
    try {
      assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "current database keeps its schema version");
      assert.deepEqual(
        (appDb.connection.prepare("SELECT value FROM sentinel").all() as Array<{ value: string }>).map((row) => row.value),
        ["keep-me"],
        "current database keeps its rows",
      );
    } finally {
      appDb.close();
    }
    assert.deepEqual(discardedBackups(dbPath), [], "no backup is produced for a compatible database");
  });

  check("A second downgrade adds a new backup instead of overwriting the first", () => {
    const dbPath = join(root, "twice.db");
    createLegacyDatabase(dbPath, outdatedVersion);
    new AppDatabase(dbPath).close();
    const firstBackups = discardedBackups(dbPath);
    assert.equal(firstBackups.length, 1, "first downgrade produced one backup");

    const downgraded = new Database(dbPath);
    downgraded.pragma(`user_version = ${outdatedVersion}`);
    downgraded.close();
    new AppDatabase(dbPath).close();

    const backups = discardedBackups(dbPath);
    const primaryBackups = backups.filter((backup) => !backup.endsWith("-wal") && !backup.endsWith("-shm"));
    assert.equal(primaryBackups.length, 2, "second downgrade produced a second primary backup");
    assert.equal(new Set(primaryBackups).size, 2, "the two primary backups are distinct paths");
    for (const backup of primaryBackups) {
      assert.equal(readUserVersion(backup), outdatedVersion, `backup still readable: ${basename(backup)}`);
    }
  });

  check("Fresh path does not create a backup", () => {
    const dbPath = join(root, "fresh", "app.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const appDb = new AppDatabase(dbPath);
    try {
      assert.equal(appDb.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "fresh database is created at the current schema");
    } finally {
      appDb.close();
    }
    assert.deepEqual(discardedBackups(dbPath), [], "fresh database has no backup");
    assert.ok(!existsSync(`${dbPath}.discarded-0`), "no placeholder backup path exists");
  });

  // rename 失败（目录只读）时必须抛错，且原库原样保留：启动失败好过静默清库。
  const canSimulateReadonlyDir = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  if (canSimulateReadonlyDir) {
    check("Rename failure throws and leaves the original database untouched", () => {
      const lockedDir = join(root, "locked");
      mkdirSync(lockedDir);
      const dbPath = join(lockedDir, "legacy.db");
      createLegacyDatabase(dbPath, outdatedVersion);
      const before = readFileSync(dbPath);

      chmodSync(lockedDir, 0o555);
      try {
        assert.throws(() => new AppDatabase(dbPath), /无法备份不兼容数据库/);
      } finally {
        chmodSync(lockedDir, 0o755);
      }

      assert.ok(existsSync(dbPath), "original database file still exists after a failed rename");
      assert.equal(readUserVersion(dbPath), outdatedVersion, "original database keeps its old user_version");
      assert.deepEqual(readSentinelValues(dbPath), ["row-1", "row-2"], "original database keeps its rows");
      assert.ok(readFileSync(dbPath).equals(before), "original database bytes are unchanged");
      assert.deepEqual(discardedBackups(dbPath), [], "no backup was produced by the failed rename");
    });
  } else {
    console.log("SKIP rename-failure case (POSIX non-root only)");
  }

  console.log(`db-schema-discard-test: ${results.length} checks PASS`);
  for (const line of results) console.log(`  ${line}`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
