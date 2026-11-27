use crate::{
    MAX_REPLY_BYTES, Request, durable,
    request_control::{self, Control, Rejection},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead},
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
};

struct Job {
    id: String,
    session: String,
    action: durable::Action,
}
fn reply(id: &str, value: Option<Value>) -> io::Result<()> {
    let error =
        || json!({"replyId":id,"historyRequestId": id, "historyLane":true, "status": "error"});
    let frame = match value {
        Some(data) => {
            json!({"replyId":id,"historyRequestId": id,"historyLane":true,"status":"ok","data":data})
        }
        None => error(),
    };
    let frame = if serde_json::to_vec(&frame)?.len() >= MAX_REPLY_BYTES {
        error()
    } else {
        frame
    };
    if let Some(control) = request_control::shared() {
        control.finish(
            id,
            frame["status"] == "ok",
            frame.get("data").cloned(),
            None,
        );
    }
    request_control::emit(&frame)
}
fn history_worker(
    engine: Arc<crate::database::DuckDbEngine>,
) -> io::Result<(SyncSender<Job>, thread::JoinHandle<io::Result<()>>)> {
    let (tx, rx) = mpsc::sync_channel::<Job>(48);
    let handle = thread::Builder::new()
        .name("durable-history".into())
        .spawn(move || {
            let mut sessions = HashMap::new();
            for job in rx {
                if !request_control::begin(&Some(job.id.clone())) {
                    continue;
                }
                let data = durable::read(&engine, &mut sessions, job.session, job.action);
                reply(&job.id, data.ok())?;
            }
            Ok(())
        })?;
    Ok((tx, handle))
}
type Input = Receiver<(Option<String>, serde_json::Result<Request>)>;

/// A bounded frame reader; an overlarge line is drained without keeping its bytes.
fn frame(input: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let mut too_large = false;
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() && !too_large {
                Ok(None)
            } else if too_large {
                Ok(Some(Vec::new()))
            } else {
                Ok(Some(bytes))
            };
        }
        let ending = available.iter().position(|b| *b == b'\n');
        let count = ending.map_or(available.len(), |i| i + 1);
        if !too_large {
            if bytes.len() + count <= MAX_REPLY_BYTES {
                bytes.extend_from_slice(&available[..count]);
            } else {
                too_large = true;
                bytes.clear();
            }
        }
        input.consume(count);
        if ending.is_some() {
            return Ok(Some(bytes));
        }
    }
}

fn control_frame(control: &Control, value: &Value, id: &str) -> io::Result<()> {
    let target = value.get("targetRequestId").and_then(Value::as_str);
    let data = match value.get("action").and_then(Value::as_str) {
        Some("cancel") if target.is_some() => control.cancel(target.unwrap()),
        Some("status") if target.is_some() => control.status(target.unwrap()),
        Some("metrics") => crate::runtime_metrics_json(),
        Some("revokeGadget") => {
            let generation = value
                .get("generation")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let invocation = value
                .get("invocationId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if !control.revoke_gadget(generation, invocation) {
                return request_control::emit(
                    &Rejection {
                        status: "error",
                        code: "INVALID_REQUEST",
                        never_started: true,
                    }
                    .frame(id),
                );
            }
            json!({"kind":"revoked"})
        }
        Some("revokeGadgets") => {
            let generations = value
                .get("generations")
                .and_then(Value::as_array)
                .filter(|values| values.len() <= 8192)
                .and_then(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().map(str::to_owned))
                        .collect::<Option<Vec<_>>>()
                });
            if !generations.is_some_and(|generations| control.revoke_gadgets(generations)) {
                return request_control::emit(
                    &Rejection {
                        status: "error",
                        code: "INVALID_REQUEST",
                        never_started: true,
                    }
                    .frame(id),
                );
            }
            json!({"kind":"revoked"})
        }
        _ => {
            return request_control::emit(
                &Rejection {
                    status: "error",
                    code: "INVALID_REQUEST",
                    never_started: true,
                }
                .frame(id),
            );
        }
    };
    request_control::emit(
        &json!({"replyId":id,"historyLane":true,"status":"ok","data":data,"generation":control.generation()}),
    )
}

/// Stdin owns admission/control; it NEVER waits for a business queue to make room.
/// Overload is a correlated neverStarted rejection, leaving cancel/revoke/status live.
pub(super) fn route_input(
    engine: Arc<crate::database::DuckDbEngine>,
    control: Arc<Control>,
) -> io::Result<(Input, thread::JoinHandle<io::Result<()>>)> {
    let (tx, rx) = mpsc::sync_channel(32);
    let input=thread::Builder::new().name("audit-input".into()).spawn(move || {
        let mut history=None;
        let mut stdin=io::stdin().lock();
        while let Some(line)=frame(&mut stdin)? {
            let value:Value=match serde_json::from_slice(&line) {Ok(value)=>value,Err(_)=>{request_control::emit(&json!({"replyId":"","status":"error","errorCode":"INVALID_REQUEST","neverStarted":true}))?;continue;}};
            let id=value.get("requestId").and_then(Value::as_str).unwrap_or("").to_owned();
            if id.is_empty() || id.len()>192 {request_control::emit(&Rejection{status:"error",code:"INVALID_REQUEST",never_started:true}.frame(&id))?;continue;}
            if value.get("operation").and_then(Value::as_str)==Some("control") {control_frame(&control,&value,&id)?;continue;}
            let operation=value.get("operation").and_then(Value::as_str).unwrap_or("").to_owned();
            let deadline=value.get("deadlineAt").and_then(Value::as_u64).unwrap_or(0);
            let request=match serde_json::from_value::<Request>(value) {Ok(request)=>request,Err(_)=>{request_control::emit(&Rejection{status:"error",code:"INVALID_REQUEST",never_started:true}.frame(&id))?;continue;}};
            if let Err(error)=control.register(&id,&operation,deadline,crate::request_may_mutate(&request)) {request_control::emit(&error.frame(&id))?;continue;}
            match request {
                Request::HistoryRead{request_id,session,action}=>{
                    if history.is_none() {history=Some(history_worker(Arc::clone(&engine))?);}
                    let job=Job{id:request_id,session,action};
                    if let Err(error)=history.as_ref().unwrap().0.try_send(job) {
                        let job=match error {mpsc::TrySendError::Full(job)|mpsc::TrySendError::Disconnected(job)=>job};
                        request_control::overload(&Some(job.id),"OVERLOADED")?;
                    }
                }
                // Older product call sites may still express revoke as a gadget operation.
                // Handle it on stdin as well, never behind an active state write.
                Request::GadgetState{request:crate::gadget_state::Request::Revoke{generation,invocation_id}}=>{
                    if !request_control::begin(&Some(id.clone())) {continue;}
                    let ok=control.revoke_gadget(generation,invocation_id);
                    let data=if ok {json!({"kind":"revoked"})} else {json!({"kind":"error","error":"STALE_WRITE"})};
                    control.finish(&id,true,Some(data.clone()),None);
                    request_control::emit(&json!({"replyId":id,"historyLane":true,"status":"ok","data":data}))?;
                }
                request=>match tx.try_send((Some(id),Ok(request))) {
                    Ok(())=>{},
                    Err(mpsc::TrySendError::Full((id,_)))=>request_control::overload(&id,"OVERLOADED")?,
                    Err(mpsc::TrySendError::Disconnected((id,_)))=>{request_control::overload(&id,"UNAVAILABLE")?;break;}
                }
            }
        }
        drop(tx);
        if let Some((sender,worker))=history {drop(sender);worker.join().map_err(|_|io::Error::other("history worker panicked"))??;}
        Ok(())
    })?;
    Ok((rx, input))
}
