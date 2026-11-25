//! Work scheduling ownership uses the same asynchronous writer as application data.
//! The UI must never synchronously wait for this database's write lock.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Acquire,
    Heartbeat,
    Release,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub action: Action,
    pub authority_id: String,
    pub now: i64,
    pub lease_ttl_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub ok: bool,
    pub authority_id: String,
    pub holder_authority_id: Option<String>,
    pub heartbeat_at: Option<i64>,
    pub acquired_at: Option<i64>,
    pub released_at: Option<i64>,
}

struct Row {
    authority_id: String,
    acquired_at: i64,
    heartbeat_at: i64,
    released_at: Option<i64>,
}

fn row(db: &Connection) -> rusqlite::Result<Option<Row>> {
    db.query_row(
        "SELECT authority_id,acquired_at,heartbeat_at,released_at FROM work_host_lease WHERE lease_id='singleton'",
        [],
        |row| Ok(Row {
            authority_id: row.get(0)?,
            acquired_at: row.get(1)?,
            heartbeat_at: row.get(2)?,
            released_at: row.get(3)?,
        }),
    ).optional()
}

pub fn run(db: &mut Connection, request: Request) -> crate::Result<Reply> {
    if request.authority_id.is_empty()
        || request.authority_id.len() > 240
        || !(1..=86_400_000).contains(&request.lease_ttl_ms)
        || request.now < 0
    {
        crate::request_control::known_failure();
        return Err("invalid Work host lease request".into());
    }
    let tx = match db.transaction_with_behavior(TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(error) => {
            crate::request_control::known_failure();
            return Err(error.into());
        }
    };
    let result = (|| -> crate::Result<Reply> {
        let previous = row(&tx)?;
        let live = previous.as_ref().is_some_and(|row| {
            row.released_at.is_none()
                && request.now.saturating_sub(row.heartbeat_at) < request.lease_ttl_ms
        });
        let ours = previous
            .as_ref()
            .is_some_and(|row| row.authority_id == request.authority_id);
        let ok = match request.action {
            Action::Acquire if !live => {
                let acquired_at = previous.as_ref().map_or(request.now, |row| {
                    request.now.max(row.acquired_at.saturating_add(1))
                });
                tx.execute(
                "INSERT INTO work_host_lease (lease_id,authority_id,acquired_at,heartbeat_at,released_at) VALUES ('singleton',?1,?2,?3,NULL)
                 ON CONFLICT(lease_id) DO UPDATE SET authority_id=excluded.authority_id,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at,released_at=NULL",
                params![request.authority_id, acquired_at, request.now],
            )?;
                true
            }
            Action::Acquire | Action::Heartbeat if live && ours => {
                tx.execute("UPDATE work_host_lease SET heartbeat_at=?1 WHERE lease_id='singleton' AND authority_id=?2",
                params![request.now, request.authority_id])?;
                true
            }
            Action::Release if ours => {
                tx.execute("UPDATE work_host_lease SET released_at=?1 WHERE lease_id='singleton' AND authority_id=?2",
                params![request.now, request.authority_id])?;
                true
            }
            _ => false,
        };
        let current = row(&tx)?;
        Ok(Reply {
            ok,
            authority_id: request.authority_id,
            holder_authority_id: current.as_ref().map(|row| row.authority_id.clone()),
            heartbeat_at: current.as_ref().map(|row| row.heartbeat_at),
            acquired_at: current.as_ref().map(|row| row.acquired_at),
            released_at: current.and_then(|row| row.released_at),
        })
    })();
    match result {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE work_host_lease (lease_id TEXT PRIMARY KEY,authority_id TEXT NOT NULL,acquired_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,released_at INTEGER)").unwrap();
        db
    }
    fn request(action: Action, authority_id: &str, now: i64) -> Request {
        Request {
            action,
            authority_id: authority_id.into(),
            now,
            lease_ttl_ms: 60_000,
        }
    }

    #[test]
    fn ownership_expiry_and_old_owner_release_are_fenced() {
        let mut db = fixture();
        assert!(
            run(&mut db, request(Action::Acquire, "one", 1_000))
                .unwrap()
                .ok
        );
        assert!(
            !run(&mut db, request(Action::Acquire, "two", 2_000))
                .unwrap()
                .ok
        );
        assert!(
            run(&mut db, request(Action::Heartbeat, "one", 20_000))
                .unwrap()
                .ok
        );
        assert!(
            !run(&mut db, request(Action::Heartbeat, "one", 80_000))
                .unwrap()
                .ok,
            "an expired heartbeat cannot silently retain the old acquisition"
        );
        let replacement = run(&mut db, request(Action::Acquire, "two", 80_001)).unwrap();
        assert!(replacement.ok);
        assert!(
            !run(&mut db, request(Action::Release, "one", 80_002))
                .unwrap()
                .ok
        );
        assert_eq!(row(&db).unwrap().unwrap().authority_id, "two");
        assert!(
            run(&mut db, request(Action::Release, "two", 80_003))
                .unwrap()
                .ok
        );
    }

    #[test]
    fn reacquiring_in_the_same_clock_tick_changes_identity() {
        let mut db = fixture();
        let a = run(&mut db, request(Action::Acquire, "one", 10)).unwrap();
        run(&mut db, request(Action::Release, "one", 10)).unwrap();
        let b = run(&mut db, request(Action::Acquire, "one", 10)).unwrap();
        assert!(b.acquired_at > a.acquired_at);
    }
}
