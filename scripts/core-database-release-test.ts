import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { initializeCoreDatabase, preparePackagedCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable, "The production Core worker is required");
const temp = await mkdtemp(join(tmpdir(), "mybuddy-database-release-"));
const dataDirectory = join(temp, ".mybuddy");
const databasePath = join(dataDirectory, "app.duckdb");
const stampPath = join(dataDirectory, "database-release.json");
const userFile = join(dataDirectory, "task-workspaces", "kept", "source.txt");
const oldDurableDatabase = join(dataDirectory, "durable", "a".repeat(64), "durable.sqlite");
const firstRelease = "0.1.200";
const nextRelease = "0.1.201";
const thirdRelease = "0.1.202";
let appDb: AppDatabase | undefined;

function createOldSqlite(filename: string): void {
  const sqlite = new DatabaseSync(filename);
  try {
    sqlite.exec("CREATE TABLE old_data AS SELECT 'must not be copied' AS value");
  } finally {
    sqlite.close();
  }
}

async function openDatabase(): Promise<AppDatabase> {
  return AppDatabase.open(databasePath, {
    readonly: true,
    runtimeAuditExecutable: executable,
    runtimeAuditSupervised: true,
  });
}

async function closeDatabase(): Promise<void> {
  await appDb?.runtimeAuditReader?.close();
  appDb?.close();
  appDb = undefined;
}

async function readStamp(): Promise<{ releaseVersion: string; databaseGeneration: string }> {
  return JSON.parse(await readFile(stampPath, "utf8"));
}

try {
  await mkdir(dirname(userFile), { recursive: true });
  await mkdir(dirname(oldDurableDatabase), { recursive: true });
  await writeFile(userFile, "keep project files");
  createOldSqlite(databasePath);
  const legacyApp = join(dataDirectory, "app.db");
  createOldSqlite(legacyApp);
  createOldSqlite(oldDurableDatabase);
  await writeFile(`${oldDurableDatabase}-shm`, "old shared memory companion");
  await writeFile(`${legacyApp}-wal`, "old WAL companion");
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, firstRelease);
  const firstStamp = await readStamp();
  assert.equal(firstStamp.releaseVersion, firstRelease);
  assert(firstStamp.databaseGeneration);
  await assert.rejects(readFile(legacyApp), { code: "ENOENT" });
  await assert.rejects(readFile(`${legacyApp}-wal`), { code: "ENOENT" });
  await assert.rejects(readFile(oldDurableDatabase), { code: "ENOENT" });
  await assert.rejects(readFile(`${oldDurableDatabase}-shm`), { code: "ENOENT" });

  appDb = await openDatabase();
  assert.equal(appDb.coreIdentity?.databaseGeneration, firstStamp.databaseGeneration);
  await appDb.writeTaskRecord({ id: "keep-across-upgrades", title: "Current release task", cwd: dirname(userFile),
    updatedAt: Date.now() });
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, firstRelease);
  assert.deepEqual(await readStamp(), firstStamp);
  assert.equal((await appDb.readTask("keep-across-upgrades"))?.title, "Current release task");
  await closeDatabase();

  // A legacy-named file introduced after cutover is not swept on upgrades.
  createOldSqlite(oldDurableDatabase);
  const lateLegacyBytes = await readFile(oldDurableDatabase);
  for (const release of [nextRelease, thirdRelease]) {
    await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, release);
    const stamp = await readStamp();
    assert.equal(stamp.releaseVersion, release);
    assert.equal(stamp.databaseGeneration, firstStamp.databaseGeneration);
    appDb = await openDatabase();
    assert.equal(appDb.coreIdentity?.databaseGeneration, firstStamp.databaseGeneration);
    assert.equal((await appDb.readTask("keep-across-upgrades"))?.title, "Current release task");
    assert.deepEqual(await readFile(oldDurableDatabase), lateLegacyBytes);
    assert.equal(await readFile(userFile, "utf8"), "keep project files");
    await closeDatabase();
  }

  await shutdownCoreWorker(dataDirectory, databasePath);
  // Losing the release stamp must not repeat the one-time cleanup.
  await rm(stampPath);
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, thirdRelease);
  const restamped = await readStamp();
  assert.equal(restamped.databaseGeneration, firstStamp.databaseGeneration);
  assert.deepEqual(await readFile(oldDurableDatabase), lateLegacyBytes);
  appDb = await openDatabase();
  assert.equal((await appDb.readTask("keep-across-upgrades"))?.title, "Current release task");
  await closeDatabase();
  await shutdownCoreWorker(dataDirectory, databasePath);

  // A development DuckDB that has never run the packaged cutover must still
  // preflight all legacy paths and run it once.
  const development = join(temp, "development", ".mybuddy");
  await mkdir(join(development, "durable"), { recursive: true });
  const devDb = join(development, "app.duckdb");
  await initializeCoreDatabase(executable, development, devDb, CURRENT_DATABASE_SCHEMA_VERSION);
  const devLegacy = join(development, "app.db");
  createOldSqlite(devLegacy);
  const outside = join(temp, "outside");
  const linkedDirectory = join(development, "durable", "b".repeat(64));
  await mkdir(outside);
  createOldSqlite(join(outside, "durable.sqlite"));
  const outsideData = await readFile(join(outside, "durable.sqlite"));
  await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(preparePackagedCoreDatabase(executable, development, CURRENT_DATABASE_SCHEMA_VERSION, "0.1.203"));
  await assert.rejects(readFile(join(development, "database-release.json")), { code: "ENOENT" });
  await readFile(devLegacy);
  await rm(linkedDirectory);
  await preparePackagedCoreDatabase(executable, development, CURRENT_DATABASE_SCHEMA_VERSION, thirdRelease);
  await assert.rejects(readFile(devLegacy), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(outside, "durable.sqlite")), outsideData);
  // An older release relied only on its external stamp. Adopt that evidence
  // on same-version startup before trusting the fast path on future launches.
  const previous = join(temp, "previous", ".mybuddy");
  const previousDb = join(previous, "app.duckdb");
  await mkdir(previous, { recursive: true });
  await initializeCoreDatabase(executable, previous, previousDb, CURRENT_DATABASE_SCHEMA_VERSION);
  const previousApp = await AppDatabase.open(previousDb, {
    readonly: true, runtimeAuditExecutable: executable, runtimeAuditSupervised: true,
  });
  const previousGeneration = previousApp.coreIdentity!.databaseGeneration;
  await previousApp.runtimeAuditReader!.close();
  previousApp.close();
  await shutdownCoreWorker(previous, previousDb);
  const previousStamp = join(previous, "database-release.json");
  await writeFile(previousStamp, JSON.stringify({releaseVersion: thirdRelease, databaseGeneration: previousGeneration}));
  const later = join(previous, "app.db");
  createOldSqlite(later);
  const laterBytes = await readFile(later);
  await preparePackagedCoreDatabase(executable, previous, CURRENT_DATABASE_SCHEMA_VERSION, thirdRelease);
  assert.equal(JSON.parse(await readFile(previousStamp, "utf8")).sqliteCutoverRecorded, true);
  await rm(previousStamp);
  await preparePackagedCoreDatabase(executable, previous, CURRENT_DATABASE_SCHEMA_VERSION, thirdRelease);
  assert.deepEqual(await readFile(later), laterBytes);
  assert.equal(JSON.parse(await readFile(previousStamp, "utf8")).databaseGeneration, previousGeneration);

  const damaged = join(temp, "damaged", ".mybuddy");
  await mkdir(damaged, { recursive: true });
  const damagedDb = join(damaged, "app.duckdb");
  const damagedBytes = Buffer.alloc(4096);
  damagedBytes.write("DUCK", 8);
  await writeFile(damagedDb, damagedBytes);
  createOldSqlite(join(damaged, "app.db"));
  const oldBytes = await readFile(join(damaged, "app.db"));
  await assert.rejects(preparePackagedCoreDatabase(executable, damaged, CURRENT_DATABASE_SCHEMA_VERSION, thirdRelease));
  assert.deepEqual(await readFile(damagedDb), damagedBytes);
  assert.deepEqual(await readFile(join(damaged, "app.db")), oldBytes);
  await assert.rejects(readFile(join(damaged, "database-release.json")), { code: "ENOENT" });
  console.log("PASS damaged unstamped DuckDB and its legacy neighbor are both preserved");
  console.log("PASS packaged Core clears legacy SQLite once and preserves DuckDB across two upgrades and an unstamped startup");

} finally {
  await closeDatabase().catch(() => undefined);
  await shutdownCoreWorker(dataDirectory, databasePath).catch(() => undefined);
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
