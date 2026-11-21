import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";

export type ReadMapping = { missing: string; found: string; cwd: string };
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
  constructor(private readonly db: Database.Database) {
    db.exec("CREATE TABLE IF NOT EXISTS path_hints(key TEXT PRIMARY KEY,task TEXT,cwd TEXT,missing TEXT,found TEXT,enabled INTEGER,week TEXT);" +
      "CREATE INDEX IF NOT EXISTS hint_lookup ON path_hints(task,cwd,missing,enabled);" +
      "CREATE TABLE IF NOT EXISTS path_hint_uses(key TEXT,conversation TEXT,run TEXT,call TEXT,repaired INTEGER DEFAULT 0,PRIMARY KEY(key,conversation,run,call))");
  }
  async publish(key: string, task: string, evidence: ReadMapping, week: string) {
    const m = readMapping(evidence.missing,evidence.found,evidence.cwd);
    if (!m || !await verified(m)) return false;
    // Conflicting locations are ambiguous. Withdraw the earlier suggestion and retain both records.
    return this.db.transaction(() => {
      const conflict = this.db.prepare("SELECT 1 FROM path_hints WHERE task=? AND cwd=? AND missing=? AND found<>?").get(task,m.cwd,m.missing,m.found);
      if (conflict) this.db.prepare("UPDATE path_hints SET enabled=0 WHERE task=? AND cwd=? AND missing=?").run(task,m.cwd,m.missing);
      return Boolean(this.db.prepare("INSERT OR IGNORE INTO path_hints VALUES(?,?,?,?,?,?,?)").run(key,task,m.cwd,m.missing,m.found,Number(!conflict),week).changes);
    }).immediate();
  }
  state(key: string) {
    return this.db.prepare("SELECT enabled,found,missing FROM path_hints WHERE key=?").get(key) as {enabled: number;found: string;missing: string} | undefined;
  }
  disable(key: string) {
    if (!this.db.prepare("UPDATE path_hints SET enabled=0 WHERE key=? AND enabled=1").run(key).changes) throw new Error("路径经验已停用");
  }
  stats(key: string) {
    const row = this.db.prepare("SELECT COUNT(*) triggers, COUNT(DISTINCT CASE WHEN repaired=1 THEN json_array(conversation,run) END) repaired FROM path_hint_uses WHERE key=?").get(key) as {triggers: number; repaired: number};
    return { ...row, errors: 0 };
  }
  has(task: string, cwd: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM path_hints WHERE task=? AND cwd=? AND enabled=1 LIMIT 1").get(task,cwd));
  }
  async observe(task: string, cwd: string, path: string, error: boolean, output: string, conversation: string, run: string, call: string) {
    if (!error) {
      this.db.prepare("UPDATE path_hint_uses SET repaired=1 WHERE conversation=? AND run=? AND key IN (SELECT key FROM path_hints WHERE task=? AND cwd=? AND found=? AND enabled=1)")
        .run(conversation,run,task,cwd,path);
      return;
    }
    if (!missingFile(output)) return;
    return this.suggest(task,cwd,path,conversation,run,call);
  }
  async suggest(task: string, cwd: string, path: string, conversation: string, run: string, call: string) {
    const h = this.db.prepare("SELECT key,found FROM path_hints WHERE enabled=1 AND task=? AND cwd=? AND missing=?").get(task,cwd,path) as {key:string;found:string} | undefined;
    if (!h) return;
    if (!await verified({ cwd, missing: path, found: h.found })) {
      this.db.prepare("UPDATE path_hints SET enabled=0 WHERE key=?").run(h.key);
      return;
    }
    if (!this.state(h.key)?.enabled) return;
    this.db.prepare("INSERT OR IGNORE INTO path_hint_uses(key,conversation,run,call) VALUES(?,?,?,?)").run(h.key,conversation,run,call);
    return "本任务曾在 " + JSON.stringify(h.found) + " 成功读取同名文件。当前路径仍不存在；请先核对它是否是本次要找的文件。";
  }
}
