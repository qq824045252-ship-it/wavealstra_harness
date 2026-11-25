/** Historical backup compatibility: list existing manifests and restore files/directories. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { FileBackupService } from "../src/main/agent/FileBackupService";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

const root = mkdtempSync(join(tmpdir(), "mybuddy-backup-test-"));
const service = new FileBackupService(root);
const workspace = join(root, "ws");
const results: string[] = [];

function check(name: string, fn: () => void): void {
  fn();
  results.push(`PASS ${name}`);
}

function historicalFixture(
  taskId: string,
  backupId: string,
  entry: { absPath: string; relPath: string; createdAt: number; size: number; kind?: "modified" | "deleted"; isDir?: boolean },
  contents: string | Record<string, string>,
): string {
  const directory = join(root, "backups", taskId);
  const manifestPath = join(directory, "manifest.json");
  mkdirSync(directory, { recursive: true });
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  manifest[backupId] = { ...entry, taskId };
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  const backupPath = join(directory, `${backupId}.bak`);
  if (typeof contents === "string") writeFileSync(backupPath, contents, "utf8");
  else for (const [path, content] of Object.entries(contents)) {
    const target = join(backupPath, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return backupPath;
}

async function main() {
  check("Empty history does not create backup storage", () => {
    assert.deepEqual(service.listBackups(), []);
    assert.equal(existsSync(join(root, "backups")), false);
  });

  const file = join(workspace, "notes", "a.txt");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "current", "utf8");
  const oldFile = historicalFixture("task-1", "old", {
    absPath: file, relPath: "notes/a.txt", createdAt: 1, size: 9, kind: "modified", isDir: false,
  }, "version-1");
  historicalFixture("task-1", "new", {
    absPath: file, relPath: "notes/a.txt", createdAt: 2, size: 9, kind: "modified", isDir: false,
  }, "version-2");
  historicalFixture("task-2", "other", {
    absPath: join(workspace, "other.txt"), relPath: "other.txt", createdAt: 3, size: 5,
  }, "other");

  const manifestPath = join(root, "backups", "task-1", "manifest.json");
  const initialManifest = readFileSync(manifestPath, "utf8");
  check("Lists historical records by time and task", () => {
    assert.deepEqual(service.listBackups().map((record) => record.backupId), ["other", "new", "old"]);
    assert.deepEqual(service.listBackups("task-1").map((record) => record.backupId), ["new", "old"]);
    assert.deepEqual(service.listBackups("unknown"), []);
    assert.equal(service.listBackups("task-1")[1].backupPath, oldFile);
    assert.equal(readFileSync(manifestPath, "utf8"), initialManifest);
  });

  if (process.argv.includes("--native")) {
    const executable = locateRuntimeAudit(process.cwd());
    assert(executable && existsSync(executable));
    const dbPath = join(root, "runtime.db");
    writeFileSync(dbPath, "");
    const runtime = new RuntimeAuditReader(executable, dbPath);
    const listOnHost = service.listBackups;
    service.listBackups = () => { throw new Error("Expected the resident Rust reader"); };
    try {
      const tiedDirectory = join(root, "backups", "task-ties");
      mkdirSync(tiedDirectory);
      const historicalPath = join(workspace, "历史记录.txt");
      const entry = JSON.stringify({ absPath: historicalPath, createdAt: 2, size: 3 });
      writeFileSync(join(tiedDirectory, "manifest.json"), `{"beta":${entry},"10":${entry},"2":${entry},"alpha":${entry}}`);
      assert.deepEqual((await service.readBackups(runtime)).map(row => row.backupId), [
        "other", "new", "2", "10", "beta", "alpha", "old",
      ]);
      assert.deepEqual((await service.readBackups(runtime, "task-ties"))[0], {
        backupId: "2", absPath: historicalPath, relPath: "历史记录.txt", backupPath: join(tiedDirectory, "2.bak"),
        createdAt: 2, size: 3, taskId: "task-ties", kind: "modified", isDir: false,
      });
      assert.deepEqual(await service.readBackups(runtime, "missing"), []);
      results.push("PASS Resident Rust lists historical backup metadata in display order");

      const restoreOnHost = service.restoreBackup;
      service.restoreBackup = () => { throw new Error("Expected the resident Rust restore"); };
      try {
        const unsupportedTarget = join(workspace, "directory-where-a-file-was");
        mkdirSync(unsupportedTarget);
        writeFileSync(join(unsupportedTarget, "keep.txt"), "keep this directory");
        historicalFixture("task-1", "blocked", {
          absPath: unsupportedTarget, relPath: "directory-where-a-file-was", createdAt: 7, size: 8,
        }, "a file");
        const nativeManifest = readFileSync(manifestPath, "utf8");

        const restored = await service.restoreWithRuntime(runtime, "task-1", "old");
        assert.deepEqual(restored, {
          backupId: "old", taskId: "task-1", absPath: file,
          relPath: "notes/a.txt", backupPath: oldFile, size: 9, createdAt: 1,
          kind: "modified", isDir: false,
        });
        assert.equal(readFileSync(file, "utf8"), "version-1");
        assert.equal(readFileSync(oldFile, "utf8"), "version-1");
        assert.deepEqual(readdirSync(dirname(file)), ["a.txt"]);

        const missingTarget = join(workspace, "native-created", "恢复.txt");
        const removedBackup = historicalFixture("task-deleted-native", "deleted", {
          absPath: missingTarget, relPath: "native-created/恢复.txt", createdAt: 6, size: 5, kind: "deleted",
        }, "saved");
        assert.equal((await service.restoreWithRuntime(runtime, "task-deleted-native", "deleted")).absPath, missingTarget);
        assert.equal(readFileSync(missingTarget, "utf8"), "saved");
        assert.equal(readFileSync(removedBackup, "utf8"), "saved");
        rmSync(removedBackup);
        await assert.rejects(service.restoreWithRuntime(runtime, "task-deleted-native", "deleted"), /备份文件缺失/);
        assert.equal(readFileSync(missingTarget, "utf8"), "saved");

        await assert.rejects(service.restoreWithRuntime(runtime, "task-2", "old"), /备份不存在: old/);
        await assert.rejects(service.restoreWithRuntime(runtime, "task-1", "blocked"), /无法还原到非文件路径/);
        assert.equal(readFileSync(join(unsupportedTarget, "keep.txt"), "utf8"), "keep this directory");
        assert.equal(readFileSync(manifestPath, "utf8"), nativeManifest);

        writeFileSync(file, "current", "utf8");
        writeFileSync(manifestPath, initialManifest, "utf8");
        results.push("PASS Resident Rust restores regular files only from the selected backup scope");
      } finally {
        service.restoreBackup = restoreOnHost;
      }

      const directoryTarget = join(workspace, "native-directory-fallback");
      mkdirSync(directoryTarget);
      writeFileSync(join(directoryTarget, "stale.txt"), "replace this");
      historicalFixture("task-directory-native", "tree", {
        absPath: directoryTarget, relPath: "native-directory-fallback", createdAt: 8, size: 9,
        kind: "deleted", isDir: true,
      }, { "sub/restored.txt": "directory contents" });
      assert.equal((await service.restoreWithRuntime(runtime, "task-directory-native", "tree")).isDir, true);
      assert.equal(readFileSync(join(directoryTarget, "sub", "restored.txt"), "utf8"), "directory contents");
      assert.equal(existsSync(join(directoryTarget, "stale.txt")), false);
      results.push("PASS Resident Rust delegates directory restoration to the existing path");
    } finally {
      service.listBackups = listOnHost;
      await runtime.close();
    }
  }

  check("Manual file restore preserves historical data", () => {
    const restored = service.restoreBackup("task-1", "old");
    assert.equal(restored.backupId, "old");
    assert.equal(readFileSync(file, "utf8"), "version-1");
    assert.equal(readFileSync(oldFile, "utf8"), "version-1");
    assert.equal(readFileSync(manifestPath, "utf8"), initialManifest);
  });

  check("Old manifests without kind/isDir remain readable", () => {
    const record = service.listBackups("task-2")[0];
    assert.equal(record.kind, "modified");
    assert.equal(record.isDir, false);
  });

  const deletedFile = join(workspace, "missing", "deleted.txt");
  historicalFixture("task-deleted", "file", {
    absPath: deletedFile, relPath: "missing/deleted.txt", createdAt: 4, size: 9, kind: "deleted", isDir: false,
  }, "delete-me");
  check("Manual restore recreates a deleted file", () => {
    assert.equal(existsSync(deletedFile), false);
    service.restoreBackup("task-deleted", "file");
    assert.equal(readFileSync(deletedFile, "utf8"), "delete-me");
  });

  const project = join(workspace, "project");
  historicalFixture("task-directory", "directory", {
    absPath: project, relPath: "project", createdAt: 5, size: 36, kind: "deleted", isDir: true,
  }, { "main.ts": "export const a = 1;", "sub/b.ts": "export const b = 2;" });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "current-only.txt"), "current", "utf8");
  check("Manual directory restore recovers the stored tree", () => {
    service.restoreBackup("task-directory", "directory");
    assert.equal(readFileSync(join(project, "main.ts"), "utf8"), "export const a = 1;");
    assert.equal(readFileSync(join(project, "sub", "b.ts"), "utf8"), "export const b = 2;");
    assert.equal(existsSync(join(project, "current-only.txt")), false);
  });

  writeFileSync(file, "pending result", "utf8");
  await assert.rejects(service.restoreWithRuntime({ restoreFileBackup: async () => undefined }, "task-1", "old"), /还原结果未确认/);
  assert.equal(readFileSync(file, "utf8"), "pending result");
  writeFileSync(file, "version-1", "utf8");
  results.push("PASS An unconfirmed restore leaves the current file alone");

  check("Unknown backup cannot overwrite current data", () => {
    assert.throws(() => service.restoreBackup("task-1", "unknown"), /备份不存在/);
    assert.equal(readFileSync(file, "utf8"), "version-1");
  });
  check("Missing backup payload fails before changing the target", () => {
    rmSync(oldFile);
    assert.throws(() => service.restoreBackup("task-1", "old"), /备份文件缺失/);
    assert.equal(readFileSync(file, "utf8"), "version-1");
  });

  console.log(results.join("\n"));
  console.log(`All ${results.length} historical backup checks passed.`);
}

void main().finally(() => {
  rmSync(root, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
