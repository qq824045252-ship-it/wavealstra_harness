import type Database from "better-sqlite3";
import type { TaskDto } from "../../../shared/agent-ipc";

type TaskMode = Pick<TaskDto, "welcomeMode" | "modePresetId">;
export const GENERAL_CODEMODE_WORKER = "general-codemode-v1";
const generalCodeMode: TaskMode = { welcomeMode: "general", modePresetId: "codemode" };
const legacyWorker: TaskMode = { modePresetId: "native" };

/** The original creation event pins the default for late assignments and new
 * rounds of the same Work, without rewriting old Works or relying on clocks.
 * An existing native task (or the task a repair continues) always wins. */
export function workWorkerTaskMode(db: Pick<Database.Database, "prepare">, workId: string, existing?: TaskMode): TaskMode {
  if (existing) return { welcomeMode: existing.welcomeMode, modePresetId: existing.modePresetId };
  const mode = db.prepare(`SELECT json_extract(payload_json,'$.workerMode')
    FROM work_events_outbox WHERE work_id=? AND event_type='work.created' LIMIT 1`).pluck().get(workId);
  return mode === GENERAL_CODEMODE_WORKER ? generalCodeMode : legacyWorker;
}
