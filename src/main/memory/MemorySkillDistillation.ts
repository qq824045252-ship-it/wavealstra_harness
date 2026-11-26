import type { MemoryTurnDto, SkillDistillationProgress } from "../../shared/memory-kernel";
import type { AppDatabase } from "../db/AppDatabase";
import { MemoryTurnRepository } from "./MemoryTurnRepository";

export interface SkillBatch {
  signal: AbortSignal;
  complete: (created: number) => void;
}

interface DistillOptions {
  enabled: () => boolean;
  scopeStamp: (taskId: string) => string;
  extract: (turns: MemoryTurnDto[], enabled: () => boolean, batch: SkillBatch) => Promise<unknown>;
}

/** One manual pass over captured turns, independent of ordinary L1 extraction state. */
export class MemorySkillDistillation {
  private controller?: AbortController;
  private progress?: SkillDistillationProgress;
  private readonly turns: MemoryTurnRepository;

  constructor(private readonly db: AppDatabase, private readonly changed: () => void) {
    this.turns = new MemoryTurnRepository(db);
  }

  status() { return this.progress && { ...this.progress }; }
  pause() { this.controller?.abort(); return this.status(); }

  start(options: DistillOptions): SkillDistillationProgress {
    if (this.controller) return this.status()!;
    if (!options.enabled()) throw new Error("请先开启记忆，再提炼历史对话。");
    // Only IDs are retained across model calls. Fetch source bodies a batch at a time.
    const rows = this.db.connection.prepare(`SELECT id, task_id FROM memory_turns
      WHERE json_extract(metadata_json,'$.skillDistilled') IS NOT 1 ORDER BY task_id,captured_at,rowid`).all() as Array<{ id: string; task_id: string }>;
    const progress: SkillDistillationProgress = { state: "running", total: rows.length, checked: 0, skipped: 0, created: 0 };
    this.progress = progress;
    const controller = this.controller = new AbortController();
    const run = async () => {
      const requiresRust = Boolean(this.db.readonly || this.db.runtimeAuditReader?.supervised);
      const mark = requiresRust
        ? null
        : this.db.connection.prepare("UPDATE memory_turns SET metadata_json=json_set(metadata_json,'$.skillDistilled',1) WHERE id=?");
      for (let i = 0; i < rows.length;) {
        if (controller.signal.aborted || !options.enabled()) break;
        const taskId = rows[i].task_id;
        let end = i + 1;
        while (end < rows.length && end - i < 8 && rows[end].task_id === taskId) end++;
        const batch = rows.slice(i, end);
        i = end;
        if (!this.turns.canExtractTask(taskId)) { progress.skipped += batch.length; continue; }
        const turns = batch.flatMap(row => this.turns.get(row.id) ?? []);
        progress.skipped += batch.length - turns.length;
        if (!turns.length) continue;
        const ids = turns.map(turn => turn.id);
        const stamp = options.scopeStamp(taskId);
        const enabled = () => !controller.signal.aborted && options.enabled() && this.turns.canExtractTask(taskId)
          && this.turns.allExist(ids) && options.scopeStamp(taskId) === stamp;
        let completed = false;
        const complete = (created: number) => {
          if (!enabled()) throw new Error("来源对话或归属已改变，请继续提炼。");
          if (mark) {
            for (const id of ids) mark.run(id);
          } else {
            this.turns.markSkillDistilled(ids);
          }
          progress.checked += ids.length;
          progress.created += created;
          completed = true;
        };
        await options.extract(turns, enabled, { signal: controller.signal, complete });
        if (controller.signal.aborted || !options.enabled()) break;
        // Fully filtered source batches perform no model call and have no candidates to save.
        if (!completed && enabled()) {
          if (requiresRust) complete(0);
          else this.db.connection.transaction(() => complete(0))();
        }
        else if (!completed) progress.skipped += ids.length;
        this.changed();
      }
      await this.turns.flush();
      progress.state = controller.signal.aborted || !options.enabled() ? "paused" : "completed";
    };
    void run().catch(error => {
      progress.state = controller.signal.aborted ? "paused" : "failed";
      if (progress.state === "failed") progress.error = error instanceof Error ? error.message : String(error);
    }).finally(() => { this.controller = undefined; this.changed(); });
    this.changed();
    return { ...progress };
  }
}
