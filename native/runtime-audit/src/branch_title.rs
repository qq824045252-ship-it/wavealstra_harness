use crate::Result;
use duckdb::{Connection, params};
use std::collections::HashSet;

pub fn next(db: &Connection, source_title: &str, dots_task_id: &str) -> Result<String> {
    let base = if source_title.is_empty() {
        "新任务"
    } else {
        source_title
    };
    let prefix = format!("{base}（分支");
    let mut statement =
        db.prepare("SELECT title FROM tasks WHERE id != ?1 AND starts_with(title, ?2)")?;
    let titles = statement
        .query_map(params![dots_task_id, prefix], |row| row.get::<_, String>(0))?
        .collect::<duckdb::Result<HashSet<_>>>()?;
    let first = format!("{prefix}）");
    if !titles.contains(&first) {
        return Ok(first);
    }
    let mut number = 2_usize;
    loop {
        let candidate = format!("{prefix} {number}）");
        if !titles.contains(&candidate) {
            return Ok(candidate);
        }
        number += 1;
    }
}
