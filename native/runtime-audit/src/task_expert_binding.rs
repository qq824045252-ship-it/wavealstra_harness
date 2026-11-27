use crate::Result;
use duckdb::{Connection, OptionalExt, params};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct BindingRow {
    task_id: String,
    desired_json: Option<String>,
    active_json: Option<String>,
    desired_skills_json: String,
    warnings_json: String,
    active_skills_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    expert_id: Option<String>,
    welcome_mode: Option<String>,
    binding: Option<BindingRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    task_id: String,
    expected_desired_json: Option<String>,
    desired_json: Option<String>,
    desired_skills_json: String,
    expert_id: Option<String>,
    at: i64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteReply {
    Saved { state: State },
    Missing,
    Stale,
    Rejected { message: String },
}

pub fn read(db: &Connection, task_id: &str) -> Result<Option<State>> {
    Ok(db
        .prepare(
            "SELECT t.expert_id, t.welcome_mode, e.task_id, e.desired_json, e.active_json,
                e.desired_skills_json, e.warnings_json, e.active_skills_json
         FROM tasks t
         LEFT JOIN task_expert_bindings e ON e.task_id = t.id
         WHERE t.id = ?1",
        )?
        .query_row([task_id], |row| {
            let binding = row
                .get::<_, Option<String>>(2)?
                .map(|task_id| {
                    Ok::<_, duckdb::Error>(BindingRow {
                        task_id,
                        desired_json: row.get(3)?,
                        active_json: row.get(4)?,
                        desired_skills_json: row.get(5)?,
                        warnings_json: row.get(6)?,
                        active_skills_json: row.get(7)?,
                    })
                })
                .transpose()?;
            Ok(State {
                expert_id: row.get(0)?,
                welcome_mode: row.get(1)?,
                binding,
            })
        })
        .optional()?)
}

pub fn write(db: &mut Connection, mutation: Mutation) -> WriteReply {
    write_transaction(db, mutation).unwrap_or_else(|error| WriteReply::Rejected {
        message: error.to_string(),
    })
}

fn write_transaction(db: &mut Connection, mutation: Mutation) -> Result<WriteReply> {
    let tx = db.transaction()?;
    let Some(before) = read(&tx, &mutation.task_id)? else {
        return Ok(WriteReply::Missing);
    };
    if before.binding.and_then(|binding| binding.desired_json) != mutation.expected_desired_json {
        return Ok(WriteReply::Stale);
    }

    tx.execute(
        "INSERT INTO task_expert_bindings (task_id, desired_json, active_json, desired_skills_json,
                active_skills_json, warnings_json, updated_at)
         VALUES (?1, ?2, NULL, ?3, '[]', '[]', ?4)
         ON CONFLICT(task_id) DO UPDATE SET desired_json=excluded.desired_json,
                desired_skills_json=excluded.desired_skills_json, warnings_json='[]',
                updated_at=excluded.updated_at",
        params![
            &mutation.task_id,
            &mutation.desired_json,
            &mutation.desired_skills_json,
            mutation.at,
        ],
    )?;
    tx.execute(
        "UPDATE tasks SET expert_id=?1, updated_at=GREATEST(updated_at, ?2) WHERE id=?3",
        params![&mutation.expert_id, mutation.at, &mutation.task_id],
    )?;
    let state = read(&tx, &mutation.task_id)?.ok_or("task removed while saving expert binding")?;
    tx.commit()?;
    Ok(WriteReply::Saved { state })
}
