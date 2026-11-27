use crate::Result;
use crate::batch4b_bot::{self, BotOp};
use crate::batch4b_work::{self, WorkOp};
use duckdb::{Connection, Transaction};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(untagged)]
pub enum BatchOp {
    Bot(BotOp),
    Work(WorkOp),
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    #[serde(rename_all = "camelCase")]
    Batch { ops: Vec<BatchOp> },
    #[serde(untagged)]
    Single(BatchOp),
}

fn apply_op(tx: &Transaction<'_>, op: BatchOp) -> Result<Value> {
    match op {
        BatchOp::Bot(bot) => batch4b_bot::apply_tx(tx, bot),
        BatchOp::Work(work) => batch4b_work::apply_tx(tx, work),
    }
}

pub fn run(conn: &mut Connection, request: Request) -> Result<Value> {
    let tx = conn.transaction()?;
    let out = match request {
        Request::Batch { ops } => ops.into_iter().map(|op| apply_op(&tx, op)).collect::<Result<Vec<_>>>()
            .map(|results| json!({ "ok": true, "results": results })),
        Request::Single(op) => apply_op(&tx, op),
    };
    match out {
        Ok(reply) => {
            crate::request_control::commit(tx)?;
            Ok(reply)
        }
        Err(error) => {
            if tx.rollback().is_ok() {
                crate::request_control::known_failure();
            }
            Err(error)
        }
    }
}
