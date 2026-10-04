/**
 * P1 产物溯源与精确刷新测试（Batch 7/8）
 *
 * 覆盖《P0-task-project-isolation-fix.md》§14-15：
 *  - createdByMessageId/toolCallId 首次写入后不可变；历史行 NULL
 *  - artifact_message_refs 幂等；task-scoped 查询；跨 task 拒绝
 *  - tool 即时事件与 snapshot 同 message 幂等
 *  - 单文件精确刷新（仅 entryFile）；无关文件不 bump
 *  - 多文件显式 dependencies；同回合多依赖只 +1
 *  - schema 幂等迁移（缺列才 ALTER）
 *
 * 运行：pnpm run test:artifact-provenance
 * 全部使用临时 DB/root，不触碰真实 ~/.mybuddy。
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactRefreshCoordinator } from "../src/main/artifact/ArtifactRefreshCoordinator";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      console.log(`PASS  ${name}`);
    })
    .catch((err) => {
      const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      results.push({ name, ok: false, detail });
      console.error(`FAIL  ${name}\n      ${detail}`);
    });
}

interface Harness {
  root: string;
  db: Database.Database;
  service: ArtifactService;
  repo: ArtifactRepository;
  coord: ArtifactRefreshCoordinator;
  close(): void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-provenance-"));
  const db = new Database(join(root, "app.db"));
  const storage = new ArtifactStorage(join(root, "artifacts"));
  const repo = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  const service = new ArtifactService(storage, repo, registry, {});
  const coord = new ArtifactRefreshCoordinator(service);
  return {
    root,
    db,
    service,
    repo,
    coord,
    close: () => {
      try {
        db.close();
      } catch {
        /* */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  await check("register：写入 createdBy* + created ref", async () => {
    const h = makeHarness();
    try {
      const ws = join(h.root, "ws");
      mkdirSync(ws, { recursive: true });
      const file = join(ws, "a.md");
      writeFileSync(file, "# a");
      const d = await h.service.register({
        taskId: "t1",
        kind: "markdown",
        workspaceFile: { entryFile: file, rootDir: ws },
        producerMessageId: "msg-1",
        producerToolCallId: "tool-1",
      });
      assert.equal(d.createdByMessageId, "msg-1");
      assert.equal(d.createdByToolCallId, "tool-1");
      const refs = h.service.listMessageRefs("t1");
      assert.equal(refs.length, 1);
      assert.equal(refs[0].relation, "created");
      assert.equal(refs[0].messageId, "msg-1");
      assert.equal(refs[0].toolCallId, "tool-1");
      assert.equal(refs[0].artifactId, d.id);
    } finally {
      h.close();
    }
  });

  await check("createdBy* 不可变：update 元数据不改写来源", async () => {
    const h = makeHarness();
    try {
      const d = await h.service.register({
        taskId: "t1",
        kind: "html",
        content: "<html/>",
        producerMessageId: "msg-orig",
        producerToolCallId: "tool-orig",
      });
      const updated = h.service.update(d.id, { title: "new title" });
      assert.equal(updated?.title, "new title");
      assert.equal(updated?.createdByMessageId, "msg-orig");
      assert.equal(updated?.createdByToolCallId, "tool-orig");
      // 直接读 repository 确认列未被 SQL update 覆盖
      const again = h.repo.get(d.id)!;
      assert.equal(again.createdByMessageId, "msg-orig");
    } finally {
      h.close();
    }
  });

  await check("无 producer 时 createdBy 为 undefined（不伪造）", async () => {
    const h = makeHarness();
    try {
      const d = await h.service.register({
        taskId: "t1",
        kind: "html",
        content: "<p/>",
      });
      assert.equal(d.createdByMessageId, undefined);
      assert.equal(d.createdByToolCallId, undefined);
      assert.equal(h.service.listMessageRefs("t1").length, 0);
    } finally {
      h.close();
    }
  });

  await check("message ref 幂等：同 message/artifact/relation 不重复", async () => {
    const h = makeHarness();
    try {
      const d = await h.service.register({
        taskId: "t1",
        kind: "html",
        content: "<p/>",
        producerMessageId: "msg-1",
        producerToolCallId: "tool-1",
      });
      const first = h.service.addMessageRef({
        taskId: "t1",
        messageId: "msg-1",
        artifactId: d.id,
        relation: "created",
        toolCallId: "tool-1",
      });
      assert.equal(first, false, "重复 created 应 IGNORE");
      const second = h.service.addMessageRef({
        taskId: "t1",
        messageId: "msg-1",
        artifactId: d.id,
        relation: "updated",
        toolCallId: "tool-2",
      });
      assert.equal(second, true);
      // 再次 updated 幂等（tool 事件 + snapshot 同 message）
      const third = h.service.addMessageRef({
        taskId: "t1",
        messageId: "msg-1",
        artifactId: d.id,
        relation: "updated",
      });
      assert.equal(third, false);
      const refs = h.service.listMessageRefs("t1", { artifactId: d.id });
      assert.equal(refs.length, 2);
      assert.deepEqual(
        refs.map((r) => r.relation).sort(),
        ["created", "updated"],
      );
    } finally {
      h.close();
    }
  });

  await check("refs 查询 task-scoped：跨 task 拒绝写入", async () => {
    const h = makeHarness();
    try {
      const a = await h.service.register({
        taskId: "task-A",
        kind: "html",
        content: "<a/>",
        producerMessageId: "m-a",
      });
      await h.service.register({
        taskId: "task-B",
        kind: "html",
        content: "<b/>",
        producerMessageId: "m-b",
      });
      assert.throws(
        () =>
          h.service.addMessageRef({
            taskId: "task-B",
            messageId: "m-x",
            artifactId: a.id,
            relation: "referenced",
          }),
        /task 不匹配/,
      );
      assert.equal(h.service.listMessageRefs("task-A").length, 1);
      assert.equal(h.service.listMessageRefs("task-B").length, 1);
      assert.equal(h.service.listMessageRefs("task-A", { messageId: "m-b" }).length, 0);
    } finally {
      h.close();
    }
  });

  await check("精确刷新：仅 entryFile 命中 bump；兄弟文件不 bump", async () => {
    const h = makeHarness();
    try {
      const ws = join(h.root, "ws");
      mkdirSync(join(ws, "sub"), { recursive: true });
      const entry = join(ws, "index.html");
      const sibling = join(ws, "sub", "other.css");
      writeFileSync(entry, "<html/>");
      writeFileSync(sibling, "body{}");
      const d = await h.service.register({
        taskId: "t1",
        kind: "html",
        workspaceFile: { entryFile: entry, rootDir: ws },
        producerMessageId: "msg-reg",
      });
      assert.equal(d.version, 1);

      const noHit = await h.coord.onWorkspaceChanged({
        taskId: "t1",
        cwd: ws,
        changedFiles: [sibling],
        messageId: "msg-sib",
      });
      assert.equal(noHit.length, 0);
      assert.equal(h.service.get(d.id)!.version, 1);
      assert.equal(h.service.listMessageRefs("t1", { messageId: "msg-sib" }).length, 0);

      const hit = await h.coord.onWorkspaceChanged({
        taskId: "t1",
        cwd: ws,
        changedFiles: [entry, sibling],
        messageId: "msg-edit",
        toolCallId: "tool-edit",
      });
      assert.equal(hit.length, 1);
      assert.equal(hit[0].version, 2);
      const updatedRefs = h.service.listMessageRefs("t1", { messageId: "msg-edit" });
      assert.equal(updatedRefs.length, 1);
      assert.equal(updatedRefs[0].relation, "updated");
      assert.equal(updatedRefs[0].toolCallId, "tool-edit");
    } finally {
      h.close();
    }
  });

  await check("多文件依赖：依赖命中 +1；无关不变；同回合多依赖只 +1", async () => {
    const h = makeHarness();
    try {
      const ws = join(h.root, "ws");
      mkdirSync(ws, { recursive: true });
      const entry = join(ws, "page.html");
      const css = join(ws, "style.css");
      const js = join(ws, "app.js");
      const noise = join(ws, "readme.md");
      writeFileSync(entry, "<html/>");
      writeFileSync(css, "body{}");
      writeFileSync(js, "console.log(1)");
      writeFileSync(noise, "# n");
      const d = await h.service.register({
        taskId: "t1",
        kind: "html",
        workspaceFile: { entryFile: entry, rootDir: ws },
      });
      h.service.setFileDependencies(d.id, [css, js]);
      const deps = h.service.listFileDependencies(d.id);
      assert.equal(deps.length, 2);

      const noiseHit = await h.coord.onWorkspaceChanged({
        taskId: "t1",
        cwd: ws,
        changedFiles: [noise],
      });
      assert.equal(noiseHit.length, 0);
      assert.equal(h.service.get(d.id)!.version, 1);

      const multi = await h.coord.onWorkspaceChanged({
        taskId: "t1",
        cwd: ws,
        changedFiles: [css, js, noise],
        messageId: "msg-multi",
      });
      assert.equal(multi.length, 1);
      assert.equal(multi[0].version, 2, "同回合多依赖只 +1");

      // 越界依赖拒绝
      assert.throws(
        () => h.service.setFileDependencies(d.id, [join(h.root, "outside.css")]),
        /rootDir/,
      );
      // 拒绝后原依赖仍在
      assert.equal(h.service.listFileDependencies(d.id).length, 2);
    } finally {
      h.close();
    }
  });

  await check("schema 幂等迁移：旧表无 created_by 列时自动补齐", () => {
    const root = mkdtempSync(join(tmpdir(), "mybuddy-prov-migrate-"));
    const dbPath = join(root, "app.db");
    try {
      const db0 = new Database(dbPath);
      db0.exec(`
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          space_id TEXT,
          kind TEXT NOT NULL,
          source_type TEXT NOT NULL,
          entry_file TEXT,
          root_dir TEXT NOT NULL,
          storage_path TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          capabilities_json TEXT NOT NULL DEFAULT '{}',
          title TEXT,
          mime_type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db0
        .prepare(
          `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, created_at, updated_at)
           VALUES ('legacy-1', 't-old', 'markdown', 'workspace-file', 'a.md', 'C:/old', 1, '{}', 1, 1)`,
        )
        .run();
      db0.close();

      const db1 = new Database(dbPath);
      const repo = new ArtifactRepository(db1);
      const d = repo.get("legacy-1");
      assert.ok(d);
      assert.equal(d!.createdByMessageId, undefined, "历史行不伪造来源");
      assert.equal(d!.createdByToolCallId, undefined);
      // 列存在
      const cols = db1.pragma("table_info(artifacts)") as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === "created_by_message_id"));
      assert.ok(cols.some((c) => c.name === "created_by_tool_call_id"));
      // 再构造一次仍幂等
      new ArtifactRepository(db1);
      db1.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await check("删除 artifact 级联清理 refs 与 dependencies", async () => {
    const h = makeHarness();
    try {
      const ws = join(h.root, "ws");
      mkdirSync(ws, { recursive: true });
      const entry = join(ws, "a.md");
      const dep = join(ws, "b.md");
      writeFileSync(entry, "a");
      writeFileSync(dep, "b");
      const d = await h.service.register({
        taskId: "t1",
        kind: "markdown",
        workspaceFile: { entryFile: entry, rootDir: ws },
        producerMessageId: "m1",
      });
      h.service.setFileDependencies(d.id, [dep]);
      h.service.addMessageRef({
        taskId: "t1",
        messageId: "m2",
        artifactId: d.id,
        relation: "referenced",
      });
      assert.ok(h.service.remove(d.id));
      assert.equal(h.service.listMessageRefs("t1").length, 0);
      assert.equal(h.service.listFileDependencies(d.id).length, 0);
    } finally {
      h.close();
    }
  });

  await check("markFilesChanged + emit 语义：register 已有 updated ref 不重复", async () => {
    const h = makeHarness();
    try {
      const ws = join(h.root, "ws");
      mkdirSync(ws, { recursive: true });
      const file = join(ws, "a.md");
      writeFileSync(file, "v1");
      const d = await h.service.register({
        taskId: "t1",
        kind: "markdown",
        workspaceFile: { entryFile: file, rootDir: resolve(ws) },
        producerMessageId: "msg-turn",
        producerToolCallId: "tool-write",
      });
      // 模拟 tool 即时 updated（已存在时）+ snapshot 再次 updated
      h.service.addMessageRef({
        taskId: "t1",
        messageId: "msg-turn",
        artifactId: d.id,
        relation: "updated",
        toolCallId: "tool-write",
      });
      await h.coord.onWorkspaceChanged({
        taskId: "t1",
        cwd: ws,
        changedFiles: [file],
        messageId: "msg-turn",
        toolCallId: "tool-write",
      });
      const refs = h.service.listMessageRefs("t1", { artifactId: d.id });
      const updated = refs.filter((r) => r.relation === "updated");
      assert.equal(updated.length, 1, "tool+snapshot 同 message 仅一条 updated");
      // The producer already registered this turn; the snapshot must not bump it again.
      assert.equal(h.service.get(d.id)!.version, 1);
      assert.equal(h.service.get(d.id)!.createdByMessageId, "msg-turn");
    } finally {
      h.close();
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("------------------------------------------------------------------------");
  console.log(`artifact-provenance: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
