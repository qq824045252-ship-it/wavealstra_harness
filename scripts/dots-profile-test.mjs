import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase.ts";
import { GatewayDotsBindings } from "../src/main/gateway/GatewayDotsBindings.ts";
import { claimDurableStorageLease } from "../src/main/agent/durable/DurableStorageLease.ts";
import { backupProfile, verifyProfile, restoreProfile } from "./dots-profile.mjs";

const root = await mkdtemp(join(tmpdir(), "mybuddy-test-profile-"));
try {
  const profile = join(root, "profile"), archive = join(root, "old"), current = join(root, "current");
  await mkdir(profile);
  const path = join(profile, "app.db");
  const app = new AppDatabase(path);
  app.openDots();
  new GatewayDotsBindings(app.connection).replace("qq-default", "a".repeat(64), "paired-user", true);
  app.close();
  const native = join(profile, "durable", "conversation"), artifact = join(profile, "交付.txt");
  await mkdir(native, { recursive: true });
  await writeFile(join(native, "history.jsonl"), '{"role":"assistant","text":"结果是 236"}\n');
  await writeFile(artifact, "第一版");
  const lease = claimDurableStorageLease(profile);
  try { await assert.rejects(backupProfile(profile, archive), { code: "DURABLE_STORAGE_OWNED" }); }
  finally { lease.release(); }
  const producer = new Database(path);
  try {
    producer.pragma("journal_mode=WAL");
    producer.pragma("wal_autocheckpoint=0");
    producer.prepare("UPDATE tasks SET title=? WHERE id=?").run("已接单", "mybuddy-dots");
    await backupProfile(profile, archive);
  } finally { producer.close(); }
  await assert.rejects(backupProfile(profile, join(profile, "nested")), /分开/);
  await assert.rejects(backupProfile(profile, archive), /已存在/);
  const manifest = await verifyProfile(archive);
  assert.ok(manifest.entries.some(e => e.key === "durable/conversation/history.jsonl"));
  assert.ok(!manifest.entries.some(e => e.key.startsWith(".mybuddy-writer-lock") || e.key === "app.db-wal"));
  const withdrawal = new Database(path);
  try {
    withdrawal.prepare("INSERT INTO memory_forget_watermarks(scope_type,scope_id,cutoff_at) VALUES('task',?,?)").run("mybuddy-dots", Date.now());
  } finally { withdrawal.close(); }
  const staleTarget = join(root, "stale");
  await assert.rejects(restoreProfile(archive, staleTarget, profile), /缺少已知的遗忘/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  await backupProfile(profile, current);
  const restored = join(root, "restored");
  await restoreProfile(current, restored, profile);
  assert.equal(await readFile(join(restored, "交付.txt"), "utf8"), "第一版");
  assert.equal(await readFile(join(restored, "durable/conversation/history.jsonl"), "utf8"), await readFile(join(native, "history.jsonl"), "utf8"));
  const reopened = new AppDatabase(join(restored, "app.db"));
  try {
    assert.equal(reopened.connection.prepare("SELECT title FROM tasks WHERE id='mybuddy-dots'").pluck().get(), "已接单");
    assert.equal(reopened.connection.prepare("SELECT count(*) FROM memory_forget_watermarks").pluck().get(), 1);
  } finally { reopened.close(); }
  await assert.rejects(restoreProfile(current, restored), /已存在/);
  const authorization = new Database(path);
  try { new GatewayDotsBindings(authorization).revoke("qq-default"); }
  finally { authorization.close(); }
  await assert.rejects(restoreProfile(current, staleTarget, profile), /已撤销的私人入口授权/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  await writeFile(join(archive, "data", "交付.txt"), "已损坏");
  await assert.rejects(verifyProfile(archive), /校验清单不符/);
  await assert.rejects(restoreProfile(archive, staleTarget), /校验清单不符/);
  await assert.rejects(access(staleTarget), { code: "ENOENT" });
  console.log("PASS cold profile backup and restore: host exclusion, committed WAL, source history, artifact, latest withdrawal, revoked binding, stale snapshot, corruption and existing destination");
} finally { await rm(root, { recursive: true, force: true }); }
