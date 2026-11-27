import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePackagedCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client.ts";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit.ts";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../src/shared/database-version.ts";
import { createArtifactDomain } from "../src/main/artifact/ArtifactDomainSetup.ts";
import { AppDatabase } from "../src/main/db/AppDatabase.ts";
import { claimDurableStorageLease } from "../src/main/agent/durable/DurableStorageLease.ts";
import { backupProfile, verifyProfile, restoreProfile } from "./dots-profile.mjs";

const root = await mkdtemp(join(tmpdir(), "mybuddy-test-profile-"));
try {
  const profile = join(root, "source", ".mybuddy"), archive = join(root, "old"), current = join(root, "current");
  await mkdir(profile, {recursive:true});
  let databaseGeneration;
  const body = "# 已交付的核算结果\n236";
  const exe = locateRuntimeAudit(process.cwd());
  await preparePackagedCoreDatabase(exe, profile, CURRENT_DATABASE_SCHEMA_VERSION, "0.1.200");
  async function withDatabase(directory, run) {
    const file=join(directory,"app.duckdb");
    const db=await AppDatabase.open(file,{runtimeAuditExecutable:exe,runtimeAuditSupervised:true});
    try { return await run(db,db.runtimeAuditReader); }
    finally { await db.runtimeAuditReader.close(); await shutdownCoreWorker(directory,file); }
  }
  await withDatabase(profile,async (db,reader) => {
    await db.openDotsAsync();
    await db.writeTaskRecord({id:"profile-task",title:"已接单",updatedAt:Date.now()});
    assert.equal((await db.readTask("profile-task")).title,"已接单");
    databaseGeneration = db.coreIdentity.databaseGeneration;
    assert.ok(databaseGeneration);
    const service = createArtifactDomain(undefined, undefined, reader, join(profile,"artifacts")).service;
    await service.register({id:"profile-result",taskId:"profile-task",kind:"markdown",title:"核算",content:body});
    assert.equal((await service.readContent("profile-result")).content, body);
    assert.ok(await reader.batch4aWrite({kind:"gatewayDotsReplace",channelId:"qq-default",
      binding:{id:"test-binding",connectionKey:"a".repeat(64),senderId:"paired-user",boundAt:1}}));
    await assert.rejects(backupProfile(profile,archive),/ownership guard/);
  });
  const native = join(profile, "durable", "conversation"), artifact = join(profile, "交付.txt");
  await mkdir(native, { recursive: true });
  await writeFile(join(native, "history.jsonl"), '{"role":"assistant","text":"结果是 236"}\n');
  await writeFile(artifact, "第一版");
  const lease = claimDurableStorageLease(profile);
  try { await assert.rejects(backupProfile(profile, archive), { code: "DURABLE_STORAGE_OWNED" }); }
  finally { lease.release(); }
  await backupProfile(profile, archive);
  await assert.rejects(backupProfile(profile, join(profile, "nested")), /分开/);
  await assert.rejects(backupProfile(profile, archive), /已存在/);
  const manifest = await verifyProfile(archive);
  assert.ok(manifest.entries.some(e => e.key === "durable/conversation/history.jsonl"));
  assert.ok(!manifest.entries.some(e => e.key.startsWith(".mybuddy-writer-lock") || e.key === "app.db-wal"));
  const mark = {scopeType:"task",scopeId:"mybuddy-dots",cutoffAt:Date.now()};
  await withDatabase(profile,async (_db,reader) => {
    assert.ok(await reader.batch3Write({kind:"memoryUpsertWatermark",...mark}));
  });
  const staleTarget = join(root, "stale");
  await assert.rejects(restoreProfile(archive, staleTarget, profile), /缺少已知的遗忘/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  // Cover target- and request-specific withdrawals independently of the scope watermark.
  const marked=join(root,"marked"), targeted=join(root,"targeted");
  await backupProfile(profile,marked);
  await withDatabase(profile,async (_db,reader) => {
    assert.ok(await reader.batch3Write({kind:"memoryUpsertForgetTarget",...mark,fingerprint:"test",textLength:4}));
  });
  await assert.rejects(restoreProfile(marked,staleTarget,profile),/缺少已知的遗忘/);
  await backupProfile(profile,targeted);
  await withDatabase(profile,async (_db,reader) => {
    assert.ok(await reader.batch3Write({kind:"memoryInsertForgetReceipt",scopeType:"task",scopeId:"mybuddy-dots",
      sourceMessageId:"test",requestFingerprint:"test-request"}));
  });
  await assert.rejects(restoreProfile(targeted,staleTarget,profile),/缺少已知的遗忘/);
  await backupProfile(profile, current);
  const restored = join(root, "restored", ".mybuddy");
  await mkdir(join(root,"restored"));
  await restoreProfile(current, restored, profile);
  assert.equal(await readFile(join(restored, "交付.txt"), "utf8"), "第一版");
  assert.equal(await readFile(join(restored, "durable/conversation/history.jsonl"), "utf8"), await readFile(join(native, "history.jsonl"), "utf8"));
  await withDatabase(restored,async db => {
    assert.equal((await db.readTask("profile-task")).title,"已接单");
    assert.equal((await db.readTask("mybuddy-dots")).id,"mybuddy-dots");
  });
  // The restored profile must independently enforce the same withdrawal.
  await assert.rejects(restoreProfile(archive,staleTarget,restored),/缺少已知的遗忘/);
  await assert.rejects(restoreProfile(current, restored), /已存在/);
  await withDatabase(profile,async (_db,reader) => {
    assert.ok(await reader.batch4aWrite({kind:"gatewayDotsReplace",channelId:"qq-default",binding:null}));
  });
  await assert.rejects(restoreProfile(current, staleTarget, profile), /已撤销的私人入口授权/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  await writeFile(join(archive, "data", "交付.txt"), "已损坏");
  await assert.rejects(verifyProfile(archive), /校验清单不符/);
  await assert.rejects(restoreProfile(archive, staleTarget), /校验清单不符/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  await assert.rejects(access(join(profile,"app.db")), {code:"ENOENT"});
  await rename(profile, join(root,"offline-original"));
  await preparePackagedCoreDatabase(exe, restored, CURRENT_DATABASE_SCHEMA_VERSION, "0.1.201");
  const stamp = JSON.parse(await readFile(join(restored, "database-release.json"), "utf8"));
  assert.equal(stamp.releaseVersion, "0.1.201");
  assert.equal(stamp.databaseGeneration, databaseGeneration);
  await withDatabase(restored, async (db,reader) => {
    assert.equal(db.coreIdentity.databaseGeneration, databaseGeneration);
    assert.equal((await db.readTask("profile-task")).title, "已接单");
    const service = createArtifactDomain(undefined, undefined, reader, join(restored,"artifacts")).service;
    const [snapshot] = await service.readTaskSnapshots(["profile-task"]);
    assert.deepEqual(snapshot.artifacts.map(row => row.id), ["profile-result"]);
    assert.equal((await service.readContent("profile-result")).content, body);
  });
  await assert.rejects(access(join(restored,"app.db")), {code:"ENOENT"});
  // Exercise a failed open on a separate profile without touching the restored archive.
  const damaged = join(root, "damaged", ".mybuddy");
  await mkdir(damaged, { recursive: true });
  const damagedFile = join(damaged, "app.duckdb");
  const bytes = Buffer.alloc(8192, 0x67);
  bytes.write("DUCK", 8);
  await writeFile(damagedFile, bytes);
  for (const stamped of [false, true]) {
    if (stamped) await writeFile(join(damaged, "database-release.json"), JSON.stringify(stamp));
    await assert.rejects(preparePackagedCoreDatabase(exe, damaged, CURRENT_DATABASE_SCHEMA_VERSION, "0.1.202"));
    assert.deepEqual(await readFile(damagedFile), bytes);
    await assert.rejects(access(join(damaged, "app.db")), {code:"ENOENT"});
  }
  console.log("PASS corrupt DuckDB retained byte-for-byte on failed unstamped and stamped upgrades");
  console.log("PASS restored cold snapshot survives a packaged release upgrade with original task, generation and managed artifact body");
  console.log("PASS cold profile backup and restore: host exclusion, committed WAL, source history, artifact, latest withdrawal, revoked binding, stale snapshot, corruption and existing destination");
} finally { await rm(root, { recursive: true, force: true }); }
