import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { NativePersistenceReply, RuntimeAuditReader } from "../../platform/runtime-audit";

export type ReadMapping = { missing: string; found: string; cwd: string };
type HintScope = { task: string; cwd: string };
type Hint = ReadMapping & HintScope & { key: string; week: string; enabled: boolean };
type HintMetrics = { hint: Hint; triggers: number; repaired: number; errors: number };

export type ReadHintQuery =
  | { kind: "list" }
  | { kind: "state"; key: string }
  | { kind: "has"; scope: HintScope }
  | { kind: "lookup"; scope: HintScope; missing: string };

export type ReadHintMutation = { scope: HintScope } & (
  | { kind: "publish"; key: string; missing: string; found: string; week: string }
  | { kind: "disable"; key: string }
  | { kind: "recordUse"; key: string; missing: string; found: string; conversation: string; run: string; call: string }
  | { kind: "repair"; found: string; conversation: string; run: string }
);

export const missingFile = (text: string) => /\bENOENT\b|no such file or directory|file not found/i.test(text);
/** A direct request to locate a named file. Plain reads of an exact path keep their original meaning. */
export function lookupFileName(text: string): string | undefined {
  const request = text.trim().match(/^(?:(?:请|帮我|麻烦|please\s+)\s*)*(?:查找|寻找|找到|定位|find\b|locate\b|look for\b)\s*(?:(?:并(?:读取|打开)|and (?:read|open)\b)\s*)?(.+?)(?:\s*(?:并读取(?:内容)?|并打开|并读出内容|and read (?:it|its contents)))?[。.!！]?$/iu);
  if (!request) return;
  const quoted = request[1].trim();
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "「": "」", "\x60": "\x60" };
  const name = pairs[quoted[0]] === quoted.at(-1) ? quoted.slice(1, -1) : quoted;
  if (name.length <= 180 && /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.[A-Za-z0-9]{1,12}$/u.test(name)) return name;
}
export function readMapping(missing: unknown, found: unknown, cwd: unknown): ReadMapping | undefined {
  const local = (p: unknown): p is string => typeof p === "string" && p.length <= 256 && p.split(/[\\/]/).every(part => /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(part));
  if (!local(missing) || !local(found) || missing === found || basename(missing) !== basename(found) || typeof cwd !== "string" || !isAbsolute(cwd)) return;
  return { missing, found, cwd };
}
async function verified(mapping: ReadMapping): Promise<boolean> {
  try { await stat(resolve(mapping.cwd,mapping.missing)); return false; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  try {
    const [root, target] = await Promise.all([realpath(mapping.cwd), realpath(resolve(mapping.cwd,mapping.found))]);
    const rel = relative(root,target);
    return Boolean(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep) && (await stat(target)).isFile());
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

export class ReadRecoveryHints {
  constructor(private readonly core: Pick<RuntimeAuditReader, "readPathHints" | "writePathHints"> | undefined) {}

  private data<T>(reply: NativePersistenceReply<T> | undefined): T {
    if (!reply) throw new Error("Core 路径经验存储不可用");
    if (reply.status === "rejected") throw new Error(reply.message);
    return reply.data;
  }

  async list(): Promise<HintMetrics[]> {
    return this.data(await this.core?.readPathHints<HintMetrics[]>({ kind: "list" }));
  }

  async publish(key: string, task: string, evidence: ReadMapping, week: string) {
    const m = readMapping(evidence.missing,evidence.found,evidence.cwd);
    if (!m || !await verified(m)) return false;
    return this.data(await this.core?.writePathHints<boolean>({
      kind: "publish", scope: { task, cwd: m.cwd }, key, missing: m.missing, found: m.found, week,
    }));
  }

  async state(key: string): Promise<Hint | null> {
    return this.data(await this.core?.readPathHints<Hint | null>({ kind: "state", key }));
  }

  async disable(key: string): Promise<void> {
    const hint = await this.state(key);
    if (!hint || !this.data(await this.core?.writePathHints<boolean>({
      kind: "disable", scope: { task: hint.task, cwd: hint.cwd }, key,
    }))) throw new Error("路径经验已停用");
  }

  async has(task: string, cwd: string): Promise<boolean> {
    return this.data(await this.core?.readPathHints<boolean>({ kind: "has", scope: { task, cwd } }));
  }

  async observe(task: string, cwd: string, path: string, error: boolean, output: string, conversation: string, run: string, call: string) {
    if (!error) {
      this.data(await this.core?.writePathHints<null>({ kind: "repair", scope: { task, cwd }, found: path, conversation, run }));
      return;
    }
    if (!missingFile(output)) return;
    return this.suggest(task,cwd,path,conversation,run,call);
  }

  async suggest(task: string, cwd: string, path: string, conversation: string, run: string, call: string) {
    const scope = { task, cwd };
    const h = this.data(await this.core?.readPathHints<Hint | null>({ kind: "lookup", scope, missing: path }));
    if (!h) return;
    if (!await verified({ cwd, missing: path, found: h.found })) {
      this.data(await this.core?.writePathHints<boolean>({ kind: "disable", scope, key: h.key }));
      return;
    }
    const recorded = this.data(await this.core?.writePathHints<boolean>({
      kind: "recordUse", scope, key: h.key, missing: path, found: h.found, conversation, run, call,
    }));
    if (!recorded) return;
    return "本任务曾在 " + JSON.stringify(h.found) + " 成功读取同名文件。当前路径仍不存在；请先核对它是否是本次要找的文件。";
  }
}
