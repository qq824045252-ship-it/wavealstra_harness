import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type Database from "better-sqlite3";
import type {
  CodeReviewChangedEvent, CodeReviewDecisionRequest, CodeReviewDecisionResult, CodeReviewDetail, CodeReviewFile,
} from "../../shared/code-review";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import {
  codeReviewTarget, readReviewState, restoreReviewState, reviewText, sameReviewContent, sameReviewState,
  type ReviewState, type ReviewTarget,
} from "./CodeReviewFiles";
import { snapshotGitDiff } from "./CodeReviewSnapshotDiff";

type Result = CodeReviewDecisionResult["results"][number];
interface RestoredFile { cwd: string; path: string }
const MAX_PREVIEW_BYTES = 512 * 1024;

interface StoredReview {
  task_id: string;
  target_key: string;
  root_entity: string;
  path: string;
  relative_path: string;
  id: string;
  status: CodeReviewFile["status"];
  before_present: 0 | 1;
  before_stamp: string;
  before_bytes: Buffer | null;
  before_mode: number | null;
  after_present: 0 | 1;
  after_stamp: string;
  after_bytes: Buffer | null;
  after_mode: number | null;
  additions: number;
  deletions: number;
  stats_available: 0 | 1;
  capture_reason: string | null;
  failure_reason: string | null;
  restoring: 0 | 1;
}

type FileRow = Pick<StoredReview, "id" | "relative_path" | "additions" | "deletions" | "status" | "capture_reason" | "failure_reason"> &
  { before_present: boolean | 0 | 1; after_present: boolean | 0 | 1; stats_available: boolean | 0 | 1 };

interface FileDetail {
  file: FileRow;
  tooLarge: boolean;
  before: string | null;
  after: string | null;
}

export type RuntimeCodeReviewQuery =
  | { kind: "list" | "pendingCount"; taskId: string }
  | { kind: "detail"; taskId: string; id: string; maxPreviewBytes: number };

export type RuntimeCodeReviewData =
  | { kind: "list"; files: FileRow[] }
  | { kind: "pendingCount"; count: number }
  | { kind: "detail"; detail: FileDetail | null };

function state(row: StoredReview, version: "before" | "after"): ReviewState {
  return {
    present: Boolean(row[`${version}_present`]),
    stamp: row[`${version}_stamp`],
    bytes: row[`${version}_bytes`],
    mode: row[`${version}_mode`],
  };
}

function dto(row: FileRow): CodeReviewFile {
  const { id, relative_path: path, additions, deletions, status } = row;
  const kind = !row.before_present ? "added" : !row.after_present ? "deleted" : "modified";
  return { id, name: basename(path), path, kind, additions, deletions, status,
    statsAvailable: Boolean(row.stats_available), canReject: status === "pending" && !row.capture_reason,
    reason: row.failure_reason ?? row.capture_reason ?? undefined };
}

async function countChanges(before: ReviewState, after: ReviewState) {
  const oldText = before.present ? reviewText(before) : "";
  const newText = after.present ? reviewText(after) : "";
  if (oldText === null || newText === null) return { additions: 0, deletions: 0, available: false };
  if (oldText === newText) return { additions: 0, deletions: 0, available: true };
  const stats = await snapshotGitDiff(oldText, newText, "numstat");
  const match = /^(\d+)\t(\d+)\t/.exec(stats ?? "");
  return { additions: Number(match?.[1] ?? 0), deletions: Number(match?.[2] ?? 0), available: match !== null };
}

/** Actual task writes supply observations while holding the same resource lease as review decisions. */
export class CodeReviewService {
  constructor(
    private readonly db: Database.Database,
    private readonly onChanged?: (event: CodeReviewChangedEvent) => void,
    private readonly reader?: RuntimeAuditReader,
  ) {}

  pendingCount(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM task_code_review WHERE task_id = ? AND status = 'pending'")
      .get(taskId) as { count: number };
    return row.count;
  }

  async readPendingCount(taskId: string): Promise<number> {
    const snapshot = await this.read({ kind: "pendingCount", taskId });
    return snapshot?.kind === "pendingCount" ? snapshot.count : this.pendingCount(taskId);
  }

  private notifyChanged(taskId: string): void {
    this.onChanged?.({ taskId, pendingCount: this.pendingCount(taskId) });
  }

  list(taskId: string): CodeReviewFile[] {
    // Keep before/after BLOBs off the list IPC and out of SQLite's result.
    const sql = `SELECT id, relative_path, before_present, after_present, additions, deletions, stats_available,
      status, capture_reason, failure_reason FROM task_code_review WHERE task_id = ?
      ORDER BY status != 'pending', relative_path`;
    return (this.db.prepare(sql).all(taskId) as FileRow[]).map(dto);
  }

  async readList(taskId: string): Promise<CodeReviewFile[]> {
    const snapshot = await this.read({ kind: "list", taskId });
    if (snapshot?.kind === "list") return snapshot.files.map(dto);
    return this.hasTask(taskId) ? this.list(taskId) : [];
  }

  async detail(taskId: string, id: string): Promise<CodeReviewDetail | null> {
    const snapshot = await this.read({ kind: "detail", taskId, id, maxPreviewBytes: MAX_PREVIEW_BYTES });
    if (snapshot?.kind === "detail") return snapshot.detail ? this.preview(snapshot.detail) : null;
    if (!this.hasTask(taskId)) return null;
    const row = this.find(taskId, id);
    if (!row) return null;
    const tooLarge = Math.max(row.before_bytes?.length ?? 0, row.after_bytes?.length ?? 0) > MAX_PREVIEW_BYTES;
    return this.preview({ file: row, tooLarge,
      before: tooLarge ? null : reviewText(state(row, "before")),
      after: tooLarge ? null : reviewText(state(row, "after")) });
  }

  private hasTask(taskId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId));
  }

  private read(query: RuntimeCodeReviewQuery): Promise<RuntimeCodeReviewData | undefined> | undefined {
    // An existing transaction may see writes that the resident connection cannot see yet.
    if (!this.db.inTransaction) return this.reader?.codeReviewData(query);
  }

  private async preview({ file, tooLarge, before, after }: FileDetail): Promise<CodeReviewDetail> {
    const detail = dto(file);
    if (tooLarge) {
      return { ...detail, before: null, after: null, reason: detail.reason ?? "文件超过 512 KiB，无法预览文本差异" };
    }
    if ((before === null && file.before_present) || (after === null && file.after_present)) {
      return { ...detail, before, after, reason: detail.reason ?? "文件内容不支持文本差异预览" };
    }
    const patch = await snapshotGitDiff(before ?? "", after ?? "", "patch");
    return patch === null
      ? { ...detail, before, after, reason: detail.reason ?? "无法生成此文件的 Git 差异" }
      : { ...detail, before, after, patch };
  }

  capture(taskId: string, root: string, path: string): ((expected?: Buffer | null) => Promise<void>) | undefined {
    let target: ReviewTarget, before: ReviewState;
    try {
      target = codeReviewTarget(root, path);
      before = readReviewState(target);
    } catch { return undefined; }
    return async (expected) => {
      try {
        const after = readReviewState(target);
        if (expected === null && after.present || expected && (!after.present || after.bytes && !after.bytes.equals(expected))) return;
        await this.record(taskId, target, before, after);
      } catch (error) { console.warn("[CodeReview] Could not record file change", error); }
    };
  }

  private get requiresRustWrites(): boolean {
    return Boolean(this.db.readonly || this.reader?.supervised);
  }

  private async writeBatch2(request: Record<string, unknown>): Promise<void> {
    if (!this.reader) throw new Error("代码审查写入：Rust 写入核心未就绪");
    const res = await this.reader.batch2Write(request);
    if (res === undefined) throw new Error("代码审查写入：Rust 核心未响应");
  }

  private async record(taskId: string, target: ReviewTarget, before: ReviewState, after: ReviewState): Promise<void> {
    const old = this.db.prepare("SELECT * FROM task_code_review WHERE task_id = ? AND target_key = ?")
      .get(taskId, target.key) as StoredReview | undefined;
    const continues = old?.status === "pending" && !old.restoring && old.root_entity === target.rootEntity &&
      sameReviewState(state(old, "after"), before);
    if (continues && sameReviewContent(before, after)) {
      if (this.requiresRustWrites) {
        await this.writeBatch2({ kind: "codeReviewUpdateAfterStamp", id: old.id, afterStamp: after.stamp });
      } else {
        this.db.prepare("UPDATE task_code_review SET after_stamp = ? WHERE id = ?").run(after.stamp, old.id);
      }
      return;
    }
    if (sameReviewContent(before, after)) return;
    const original = continues ? state(old, "before") : before;
    if (sameReviewContent(original, after)) {
      if (old) {
        if (this.requiresRustWrites) {
          await this.writeBatch2({ kind: "codeReviewDelete", id: old.id });
        } else {
          this.db.prepare("DELETE FROM task_code_review WHERE id = ?").run(old.id);
        }
        this.notifyChanged(taskId);
      }
      return;
    }
    const captureReason = before.reason ?? after.reason ?? (continues ? old.capture_reason : null);
    const { additions, deletions, available } = await countChanges(original, after);
    // The caller holds the mutation lease until this recorded snapshot is saved.
    if (this.requiresRustWrites) {
      await this.writeBatch2({
        kind: "codeReviewUpsert",
        taskId,
        targetKey: target.key,
        rootEntity: target.rootEntity,
        path: target.path,
        relativePath: target.relativePath,
        id: randomUUID(),
        beforePresent: Number(original.present),
        beforeStamp: original.stamp,
        beforeBytesBase64: original.bytes ? original.bytes.toString("base64") : null,
        beforeMode: original.mode ?? null,
        afterPresent: Number(after.present),
        afterStamp: after.stamp,
        afterBytesBase64: after.bytes ? after.bytes.toString("base64") : null,
        afterMode: after.mode ?? null,
        additions,
        deletions,
        statsAvailable: Number(available),
        captureReason: captureReason ?? null,
      });
    } else {
      this.db.prepare(`INSERT OR REPLACE INTO task_code_review (
        task_id, target_key, root_entity, path, relative_path, id, status,
        before_present, before_stamp, before_bytes, before_mode,
        after_present, after_stamp, after_bytes, after_mode, additions, deletions, stats_available, capture_reason
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        taskId, target.key, target.rootEntity, target.path, target.relativePath, randomUUID(),
        Number(original.present), original.stamp, original.bytes, original.mode,
        Number(after.present), after.stamp, after.bytes, after.mode,
        additions, deletions, Number(available), captureReason,
      );
    }
    this.notifyChanged(taskId);
  }

  async decide(request: CodeReviewDecisionRequest, workspace: () => string | undefined,
    withLease: <T>(path: string, operation: () => Promise<T> | T) => Promise<T>,
    onRestored?: (file: RestoredFile) => void): Promise<CodeReviewDecisionResult> {
    const results: Result[] = [];
    const lookupPath = this.db.prepare("SELECT path FROM task_code_review WHERE task_id = ? AND id = ?");
    for (const id of new Set(request.ids)) {
      const old = lookupPath.get(request.taskId, id) as Pick<StoredReview, "path"> | undefined;
      if (!old) {
        results.push({ id, status: "conflict", reason: "审查内容已有新版本，请刷新后重试" });
        continue;
      }
      try {
        results.push(await withLease(old.path, () => this.decideOne(request, id, workspace, onRestored)));
      } catch (error) {
        results.push({ id, status: "conflict", reason: error instanceof Error ? error.message : "文件暂时无法处理" });
      }
    }
    if (results.length) this.notifyChanged(request.taskId);
    return { files: this.list(request.taskId), results };
  }

  private find(taskId: string, id: string): StoredReview | undefined {
    return this.db.prepare("SELECT * FROM task_code_review WHERE task_id = ? AND id = ?").get(taskId, id) as StoredReview | undefined;
  }

  private async decideOne(request: CodeReviewDecisionRequest, id: string, workspace: () => string | undefined,
    onRestored?: (file: RestoredFile) => void): Promise<Result> {
    const row = this.find(request.taskId, id);
    if (!row) return { id, status: "conflict", reason: "审查内容已有新版本，请刷新后重试" };
    const status = request.action === "accept" ? "accepted" : "rejected";
    if (row.status === status) return { id, status };
    if (row.status !== "pending") return { id, status: "conflict", reason: "这次变更已经审查" };
    if (request.action === "reject" && row.capture_reason) return { id, status: "unavailable", reason: row.capture_reason };

    // A prior process could have restored the file but stopped before committing its receipt.
    let appliedStatus: typeof status = status;
    let restored: RestoredFile | undefined;
    if (request.action === "reject" || row.restoring) {
      try {
        const root = workspace();
        if (!root) throw new Error("当前任务没有可用的工作区");
        const path = resolve(root, row.relative_path);
        const target = codeReviewTarget(root, path);
        if (target.key !== row.target_key) throw new Error("任务工作区已变化");
        if (target.rootEntity !== row.root_entity) throw new Error("任务工作区目录已更换");
        const before = state(row, "before"), after = state(row, "after");
        const current = readReviewState(target);
        if (row.restoring && sameReviewContent(current, before)) {
          appliedStatus = "rejected";
          restored = { cwd: root, path };
        } else if (request.action === "reject") {
          if (!sameReviewState(current, after)) throw new Error("文件已被手工修改或被其他任务修改");
          if (this.requiresRustWrites) {
            await this.writeBatch2({ kind: "codeReviewSetRestoring", id });
          } else {
            this.db.prepare("UPDATE task_code_review SET restoring = 1 WHERE id = ?").run(id);
          }
          restoreReviewState(target, before, after);
          restored = { cwd: root, path };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "无法安全还原文件";
        if (this.requiresRustWrites) {
          await this.writeBatch2({ kind: "codeReviewSetFailure", id, reason });
        } else {
          this.db.prepare("UPDATE task_code_review SET failure_reason = ? WHERE id = ?").run(reason, id);
        }
        return { id, status: "conflict", reason };
      }
    }
    if (this.requiresRustWrites) {
      await this.writeBatch2({ kind: "codeReviewFinish", id, status: appliedStatus });
    } else {
      this.db.prepare("UPDATE task_code_review SET status = ?, failure_reason = NULL, restoring = 0 WHERE id = ?").run(appliedStatus, id);
    }
    if (restored) onRestored?.(restored);
    return { id, status: appliedStatus };
  }
}
