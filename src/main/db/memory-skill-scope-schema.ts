import type Database from "better-sqlite3";

/** Extend the current leaf table in place without resetting the application database. */
export function ensureBotSkillScope(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_skill_candidates'")
    .get() as { sql: string } | undefined;
  if (!table || table.sql.includes("'bot'")) return;
  const expanded = table.sql.replace("memory_skill_candidates", "memory_skill_candidates_expanded")
    .replace("scope_type IN ('global','workspace','project')", "scope_type IN ('global','workspace','project','bot')");
  if (expanded === table.sql || !expanded.includes("'bot'")) throw new Error("无法识别学习技能 scope schema，拒绝重建");
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_skill_candidates' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  db.transaction(() => {
    db.exec(expanded);
    db.exec(`INSERT INTO memory_skill_candidates_expanded SELECT * FROM memory_skill_candidates;
      DROP TABLE memory_skill_candidates;
      ALTER TABLE memory_skill_candidates_expanded RENAME TO memory_skill_candidates;`);
    for (const index of indexes) db.exec(index.sql);
  })();
}
