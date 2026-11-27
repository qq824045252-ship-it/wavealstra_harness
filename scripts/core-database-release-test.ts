import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { preparePackagedCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
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
  await writeFile(`${legacyApp}-wal`, "old WAL companion");
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, firstRelease);
  const firstStamp = await readStamp();
  assert.equal(firstStamp.releaseVersion, firstRelease);
  assert(firstStamp.databaseGeneration);
  await assert.rejects(readFile(legacyApp), { code: "ENOENT" });
  await assert.rejects(readFile(`${legacyApp}-wal`), { code: "ENOENT" });

  appDb = await openDatabase();
  assert.equal(appDb.coreIdentity?.databaseGeneration, firstStamp.databaseGeneration);
  await appDb.writeTaskRecord({ id: "keep-until-upgrade", title: "Current release task", cwd: dirname(userFile),
    updatedAt: Date.now() });
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, firstRelease);
  assert.deepEqual(await readStamp(), firstStamp);
  assert.equal((await appDb.readTask("keep-until-upgrade"))?.title, "Current release task");
  await closeDatabase();

  createOldSqlite(oldDurableDatabase);
  await writeFile(`${oldDurableDatabase}-shm`, "old shared memory companion");
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, nextRelease);
  let nextStamp = await readStamp();
  assert.equal(nextStamp.releaseVersion, nextRelease);
  assert.notEqual(nextStamp.databaseGeneration, firstStamp.databaseGeneration);
  appDb = await openDatabase();
  assert.equal(appDb.coreIdentity?.databaseGeneration, nextStamp.databaseGeneration);
  assert.equal(await appDb.readTask("keep-until-upgrade"), undefined);
  await assert.rejects(readFile(oldDurableDatabase), { code: "ENOENT" });
  await assert.rejects(readFile(`${oldDurableDatabase}-shm`), { code: "ENOENT" });
  assert.equal(await readFile(userFile, "utf8"), "keep project files");
  await closeDatabase();

  await shutdownCoreWorker(dataDirectory, databasePath);
  await rm(databasePath);
  await writeFile(`${databasePath}.wal`, "leftover sidecar during release reset");
  const beforeInterruptedReset = nextStamp;
  await assert.rejects(preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, nextRelease));
  assert.deepEqual(await readStamp(), beforeInterruptedReset);
  assert.equal(await readFile(`${databasePath}.wal`, "utf8"), "leftover sidecar during release reset");
  const interruptedRelease = "0.1.202";
  await preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, interruptedRelease);
  nextStamp = await readStamp();
  assert.equal(nextStamp.releaseVersion, interruptedRelease);
  assert.notEqual(nextStamp.databaseGeneration, beforeInterruptedReset.databaseGeneration);

  const outside = join(temp, "outside");
  const linkedDirectory = join(dataDirectory, "durable", "b".repeat(64));
  await mkdir(outside);
  createOldSqlite(join(outside, "durable.sqlite"));
  const outsideData = await readFile(join(outside, "durable.sqlite"));
  await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(preparePackagedCoreDatabase(executable, dataDirectory, CURRENT_DATABASE_SCHEMA_VERSION, "0.1.203"));
  assert.deepEqual(await readStamp(), nextStamp);
  assert.deepEqual(await readFile(join(outside, "durable.sqlite")), outsideData);
  appDb = await openDatabase();
  assert.equal(appDb.coreIdentity?.databaseGeneration, nextStamp.databaseGeneration);
  await closeDatabase();
  console.log("PASS packaged Core initialization rebuilds only on release change, preserves project files and rejects linked DB targets");
} finally {
  await closeDatabase().catch(() => undefined);
  await shutdownCoreWorker(dataDirectory, databasePath).catch(() => undefined);
  await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
