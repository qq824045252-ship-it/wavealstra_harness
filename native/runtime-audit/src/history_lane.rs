use crate::{MAX_REPLY_BYTES, Request, durable};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
};

struct Job {
    id: String,
    session: String,
    action: durable::Action,
}

fn reply(id: &str, value: Option<Value>) -> io::Result<()> {
    let error = || json!({"historyRequestId": id, "status": "error"});
    let frame = match value {
        Some(data) => json!({"historyRequestId": id, "status": "ok", "data": data}),
        None => error(),
    };
    let mut line = serde_json::to_vec(&frame)?;
    if line.len() >= MAX_REPLY_BYTES {
        line = serde_json::to_vec(&error())?;
    }
    line.push(b'\n');
    let mut out = io::stdout().lock();
    out.write_all(&line)?;
    out.flush()
}

fn history_worker() -> io::Result<(SyncSender<Job>, thread::JoinHandle<io::Result<()>>)> {
    // 32 ordinary requests plus room to close every admitted SQLite snapshot.
    let (tx, rx) = mpsc::sync_channel::<Job>(48);
    let handle = thread::Builder::new()
        .name("durable-history".into())
        .spawn(move || {
            let mut sessions = HashMap::new();
            for job in rx {
                let data = durable::read(&mut sessions, job.session, job.action);
                reply(&job.id, data.ok())?;
            }
            Ok(())
        })?;
    Ok((tx, handle))
}

type Input = Receiver<serde_json::Result<Request>>;
pub(super) fn route_input() -> io::Result<(Input, thread::JoinHandle<io::Result<()>>)> {
    let (tx, rx) = mpsc::sync_channel(8);
    let input = thread::Builder::new()
        .name("audit-input".into())
        .spawn(move || {
            let mut history = None;
            for line in io::stdin().lock().lines() {
                let line = line?;
                match serde_json::from_str(&line) {
                    Ok(Request::HistoryRead {
                        request_id,
                        session,
                        action,
                    }) => {
                        if history.is_none() {
                            history = Some(history_worker()?);
                        }
                        let job = Job {
                            id: request_id,
                            session,
                            action,
                        };
                        if let Err(error) = history.as_ref().unwrap().0.try_send(job) {
                            let job = match error {
                                mpsc::TrySendError::Full(job)
                                | mpsc::TrySendError::Disconnected(job) => job,
                            };
                            reply(&job.id, None)?;
                        }
                    }
                    Err(error) => {
                        // Even a rejected action must reply to its own request, never
                        // consume the untagged slot of a concurrent database write.
                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Header<'a> {
                            operation: &'a str,
                            request_id: Option<&'a str>,
                        }
                        if let Ok(Header {
                            operation: "historyRead",
                            request_id,
                        }) = serde_json::from_str(&line)
                        {
                            if let Some(id) = request_id {
                                reply(id, None)?;
                            }
                        } else if tx.send(Err(error)).is_err() {
                            break;
                        }
                    }
                    other => {
                        if tx.send(other).is_err() {
                            break;
                        }
                    }
                }
            }
            drop(tx);
            if let Some((sender, worker)) = history {
                drop(sender);
                worker
                    .join()
                    .map_err(|_| io::Error::other("history worker panicked"))??;
            }
            Ok(())
        })?;
    Ok((rx, input))
}
