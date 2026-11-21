import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodemodeSandbox, loadQuickJSWasm, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { z } from "zod";
import { hookEvents, type HookDraft, type NativeHookEvent, type NativeHookReceipt, type PublishedHook } from "../../../shared/native-hooks";

const id = z.string().trim().min(1).max(256);
const feedback = z.string().trim().min(1).max(1500);
const draftSchema = z.object({
  title: id, event: z.enum(hookEvents), actor: z.enum(["all", "main", "subagent"]),
  tool: z.string().trim().max(256),
  scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("global") }).strict(),
    z.object({ kind: z.enum(["project", "workspace", "task"]), id }).strict()]),
  script: z.string().trim().min(1).max(16000),
  cases: z.array(z.object({ input: z.record(z.string(), z.json()), expected: z.union([z.literal(true), feedback]) })).min(1).max(12),
}).strict().refine(d => !d.tool || d.event === "beforeTool" || d.event === "afterTool", "只有工具事件可以指定工具名称");

/** Shared by Code Mode and hooks in both dev and unpacked Electron installations. */
export function durableSandboxAssets(directory?: string): Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> {
  const base = directory?.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
  if (!base) return {};
  const wasm = join(base, "quickjs.wasm"), worker = join(base, "codemode-worker.cjs");
  return existsSync(wasm) && existsSync(worker) ? { wasm: loadQuickJSWasm(wasm), workerUrl: pathToFileURL(worker) } : {};
}

type VersionRow = { id: string; revision: number; draft: string; hash: string };
type ActiveRow = VersionRow & { generation: number; enabled: number };
export interface SelectedHook { id: string; revision: number; draft: HookDraft }
export interface HookScope { taskId: string; projectId?: string | null; spaceId?: string | null }
const joined = "FROM hooks h JOIN versions v ON h.id=v.id AND h.revision=v.revision";

export class NativeHookStore {
  private readonly db: Database.Database;
  private readonly available: Database.Statement;
  private readonly toolVersions: Database.Statement;
  constructor(path: string, private readonly assets: () => ReturnType<typeof durableSandboxAssets> = () => ({})) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT NOT NULL, revision INTEGER NOT NULL, event TEXT NOT NULL, tool TEXT NOT NULL,
        draft TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(id, revision));
      CREATE INDEX IF NOT EXISTS hook_event ON versions(event, tool);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT NOT NULL, revision INTEGER NOT NULL, taskId TEXT NOT NULL, conversationId TEXT NOT NULL,
        nativeTaskId INTEGER NOT NULL, event TEXT NOT NULL, tool TEXT NOT NULL, callId TEXT NOT NULL, actor TEXT NOT NULL, runKey TEXT NOT NULL,
        at INTEGER NOT NULL, outcome TEXT NOT NULL, message TEXT NOT NULL, parentTaskId INTEGER,
        UNIQUE(id, revision, taskId, conversationId, nativeTaskId, event, callId));
      CREATE INDEX IF NOT EXISTS hook_recent ON receipts(id, at DESC);
      CREATE INDEX IF NOT EXISTS hook_finish ON receipts(taskId, conversationId, runKey, event, outcome);
      CREATE INDEX IF NOT EXISTS hook_nested ON receipts(taskId, conversationId, parentTaskId) WHERE parentTaskId IS NOT NULL;
      CREATE TABLE IF NOT EXISTS readback_evidence (
        id TEXT, revision INTEGER, taskId TEXT, conversationId TEXT, runKey TEXT, inputEntry INTEGER, observed TEXT,
        PRIMARY KEY(id,revision,taskId,conversationId,runKey,inputEntry,observed));
    `);
    this.available = this.db.prepare("SELECT v.id, v.revision, v.draft " + joined
      + " WHERE h.enabled=1 AND v.event=? AND (v.tool='' OR v.tool=?) ORDER BY h.rowid");
    this.toolVersions = this.db.prepare("SELECT 1 FROM versions WHERE event IN ('beforeTool','afterTool') LIMIT 1");
  }
  hasToolVersions(): boolean { return Boolean(this.toolVersions.get()); }
  close(): void { if (this.db.open) this.db.close(); }
  private describe(row: ActiveRow): PublishedHook {
    const versions = this.db.prepare("SELECT revision FROM versions WHERE id=? ORDER BY revision DESC").pluck().all(row.id) as number[];
    return { id: row.id, revision: row.revision, draft: JSON.parse(row.draft), hash: row.hash,
      generation: row.generation, enabled: Boolean(row.enabled), versions };
  }
  list(): PublishedHook[] {
    return (this.db.prepare("SELECT v.*,h.generation,h.enabled " + joined + " ORDER BY h.rowid").all() as ActiveRow[]).map(row => this.describe(row));
  }
  candidates(event: NativeHookEvent, tool = ""): SelectedHook[] {
    return (this.available.all(event, tool) as VersionRow[]).map(row => ({ id: row.id, revision: row.revision, draft: JSON.parse(row.draft) }));
  }
  version(id: string, revision: number): SelectedHook {
    const row = this.db.prepare("SELECT draft FROM versions WHERE id=? AND revision=?").get(id, revision) as { draft: string } | undefined;
    if (!row) throw new Error("Hook 版本不存在");
    return { id, revision, draft: JSON.parse(row.draft) };
  }
  async check(draft: HookDraft, input: Record<string, unknown>, signal?: AbortSignal): Promise<true | string> {
    if (JSON.stringify(input).length > 512000) throw new Error("Hook 输入超过 512000 字符");
    const sandbox = new CodemodeSandbox({ ...this.assets(), timeoutMs: 3000, memoryLimitBytes: 16 * 1024 * 1024 });
    try {
      const result = await sandbox.execute('const event = load("event");\n' + draft.script, { store: { event: input }, signal });
      signal?.throwIfAborted();
      if (!result.ok) throw new Error(result.error.message.slice(0, 1500));
      if (result.value === true) return true;
      const parsed = feedback.safeParse(result.value);
      if (!parsed.success) throw new Error("检查脚本必须返回 true 或 1 到 1500 字的处理说明");
      return parsed.data;
    } finally { await sandbox.close(); }
  }
  async publish(input: HookDraft, base?: { id: string; generation: number }): Promise<PublishedHook> {
    return this.publishVersion(input, base);
  }
  async installImprovement(input: HookDraft, key: string): Promise<PublishedHook> {
    if (!/^improvement-[a-f0-9]{64}$/.test(key)) throw new Error("无效的自动改进标识");
    return this.publishVersion(input, undefined, key);
  }
  private async publishVersion(input: HookDraft, base?: { id: string; generation: number }, managedKey?: string): Promise<PublishedHook> {
    const draft = draftSchema.parse(input);
    for (const [i, sample] of draft.cases.entries()) {
      const actual = await this.check(draft, { ...sample.input, event: draft.event, tool: draft.tool || sample.input.tool || "" });
      if (actual !== sample.expected) throw new Error(`用例 ${i + 1} 期望 ${JSON.stringify(sample.expected)}，实际 ${JSON.stringify(actual)}`);
    }
    const encoded = JSON.stringify(draft);
    const hash = createHash("sha256").update(encoded).digest("hex");
    return this.db.transaction(() => {
      const key = base?.id ?? managedKey ?? randomUUID();
      if (managedKey) {
        const existing = this.find(key);
        if (existing) return existing;
      }
      const current = this.db.prepare("SELECT generation,enabled FROM hooks WHERE id=?").get(key) as { generation: number; enabled: number } | undefined;
      if (base && (!current || base.generation !== current.generation)) throw new Error("Hook 已变化，请刷新后重试");
      const revision = 1 + Number(this.db.prepare("SELECT MAX(revision) FROM versions WHERE id=?").pluck().get(key));
      this.db.prepare("INSERT INTO versions VALUES(?,?,?,?,?,?)").run(key, revision, draft.event, draft.tool, encoded, hash);
      const generation = (current?.generation ?? 0) + 1, enabled = current?.enabled ?? 1;
      this.db.prepare("INSERT INTO hooks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation")
        .run(key, revision, generation, enabled);
      return this.describe({ id: key, revision, draft: encoded, hash, generation, enabled });
    }).immediate();
  }
  find(key: string): PublishedHook | undefined {
    const row = this.db.prepare("SELECT v.*,h.generation,h.enabled " + joined + " WHERE h.id=?").get(key) as ActiveRow | undefined;
    return row && this.describe(row);
  }
  improvementMetrics(id: string, revision: number) {
    const counts = this.db.prepare("SELECT COUNT(CASE WHEN outcome='feedback' THEN 1 END) AS triggers, COUNT(CASE WHEN outcome='error' THEN 1 END) AS errors FROM receipts WHERE id=? AND revision=?").get(id, revision) as { triggers: number; errors: number };
    const repaired = Number(this.db.prepare("SELECT COUNT(*) FROM readback_evidence v WHERE id=? AND revision=? AND observed='verified' AND EXISTS (SELECT 1 FROM readback_evidence r WHERE r.id=v.id AND r.revision=v.revision AND r.taskId=v.taskId AND r.conversationId=v.conversationId AND r.runKey=v.runKey AND r.inputEntry=v.inputEntry AND r.observed='written' AND r.rowid<v.rowid)").pluck().get(id, revision));
    return { ...counts, repaired };
  }
  childReviewReceipts(task: string, conversation: string) {
    return this.db.prepare(`SELECT id,revision,COUNT(*) executions FROM receipts
      WHERE taskId=? AND conversationId=? AND actor='subagent' GROUP BY id,revision ORDER BY id,revision`)
      .all(task,conversation) as { id: string; revision: number; executions: number }[];
  }
  generationReceipts(task: string, conversation: string, nativeTaskIds: readonly number[]) {
    const stmt = this.db.prepare(`SELECT id,revision,event,nativeTaskId,actor,tool,callId,outcome,at FROM receipts
      WHERE taskId=? AND conversationId=? AND nativeTaskId=? ORDER BY at,rowid LIMIT 100`);
    return [...new Set(nativeTaskIds)].flatMap(id => stmt.all(task, conversation, id));
  }
  hadImprovementFeedback(id: string, revision: number, task: string, conversation: string, generation: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM receipts WHERE id=? AND revision=? AND taskId=? AND conversationId=? AND nativeTaskId=? AND outcome='feedback' LIMIT 1")
      .get(id,revision,task,conversation,generation));
  }
  recordReadback(id: string, revision: number, taskId: string, conversationId: string, runKey: string, inputEntry: number, observed: string) {
    this.db.prepare("INSERT OR IGNORE INTO readback_evidence VALUES(?,?,?,?,?,?,?)").run(id, revision, taskId, conversationId, runKey,inputEntry,observed);
  }
  activate(key: string, generation: number, revision: number, enabled: boolean): PublishedHook {
    z.boolean().parse(enabled);
    return this.db.transaction(() => {
      const version = this.db.prepare("SELECT * FROM versions WHERE id=? AND revision=?").get(key, revision) as VersionRow | undefined;
      if (!version) throw new Error("Hook 版本不存在");
      const changed = this.db.prepare("UPDATE hooks SET enabled=?, revision=?, generation=generation+1 WHERE id=? AND generation=?")
        .run(Number(enabled), revision, key, generation);
      if (!changed.changes) throw new Error("Hook 已变化，请刷新后重试");
      return this.describe({ ...version, generation: generation + 1, enabled: Number(enabled) });
    }).immediate();
  }
  record(r: NativeHookReceipt, runKey: string, parentTaskId?: number): void {
    this.db.prepare(`INSERT INTO receipts VALUES(@id,@revision,@taskId,@conversationId,@nativeTaskId,@event,@tool,@callId,@actor,@runKey,@at,@outcome,@message,@parentTaskId)
      ON CONFLICT(id,revision,taskId,conversationId,nativeTaskId,event,callId) DO UPDATE SET at=excluded.at,outcome=excluded.outcome,message=excluded.message`)
      .run({ ...r, runKey, parentTaskId: parentTaskId ?? null });
  }
  nestedFeedback(taskId: string, conversationId: string, parentTaskId: number): string {
    const rows = this.db.prepare(`SELECT json_extract(v.draft,'$.title') AS title,r.revision,r.tool,r.message FROM receipts r
      JOIN versions v ON r.id=v.id AND r.revision=v.revision WHERE r.taskId=? AND r.conversationId=? AND r.parentTaskId=?
      AND r.event='afterTool' AND r.outcome!='pass' ORDER BY r.at,r.rowid LIMIT 16`)
      .all(taskId, conversationId, parentTaskId) as { title: string; revision: number; tool: string; message: string }[];
    return rows.map(r => `[Hook · ${r.title} v${r.revision} · ${r.tool}] ${r.message}`).join("\n");
  }
  finishAttempts(taskId: string, conversationId: string, runKey: string): number {
    return Number(this.db.prepare("SELECT COUNT(DISTINCT nativeTaskId) FROM receipts WHERE taskId=? AND conversationId=? AND runKey=? AND event='beforeFinish' AND outcome!='pass'")
      .pluck().get(taskId, conversationId, runKey));
  }
  receipts(key: string): NativeHookReceipt[] {
    return this.db.prepare("SELECT id,revision,event,taskId,conversationId,nativeTaskId,actor,tool,callId,at,outcome,message FROM receipts WHERE id=? ORDER BY at DESC,rowid DESC LIMIT 100")
      .all(key) as NativeHookReceipt[];
  }
}
