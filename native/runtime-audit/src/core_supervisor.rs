//! A Core owns its worker independently of any UI connection. Network I/O never runs
//! on the supervisor loop or while holding its routing mutex. Every queue is bounded.
use crate::core_lease::{self, Lease};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const POLL: Duration = Duration::from_millis(10);
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(1);
const WRITE_DEADLINE: Duration = Duration::from_millis(750);
const MAX_HANDSHAKES: usize = 16;
const MAX_PENDING: usize = 512;
const MAX_FRAME: usize = 32 * 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_INPUT_QUEUED: usize = 32;

struct ActiveClient {
    epoch: u64,
    output: mpsc::SyncSender<Vec<u8>>,
    queued_bytes: Arc<AtomicUsize>,
    socket: TcpStream,
    history: HashSet<String>,
    gadget_generations: HashSet<String>,
}

#[derive(Default)]
struct Routing {
    active: Option<ActiveClient>,
    owners: HashMap<String, u64>,
}

struct Relay {
    routing: Mutex<Routing>,
    input: mpsc::SyncSender<Vec<u8>>,
    input_count: Arc<AtomicUsize>,
    input_bytes: Arc<AtomicUsize>,
    handshakes: AtomicUsize,
    next_epoch: AtomicU64,
    stopping: AtomicBool,
}

fn frame(value: Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(&value).expect("JSON value is serializable");
    bytes.push(b'\n');
    bytes
}

/// Keeps newline framing intact across disconnects and bounds an unterminated frame.
fn read_frame(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::other("truncated frame"))
            };
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if result.len() + count > limit {
            return Err(io::Error::other("frame exceeds limit"));
        }
        let complete = available[count - 1] == b'\n';
        result.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete {
            return Ok(Some(result));
        }
    }
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> io::Result<()> {
    let deadline = Instant::now() + WRITE_DEADLINE;
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "client stopped reading"))?;
        stream.set_write_timeout(Some(remaining))?;
        let written = stream.write(&bytes[offset..])?;
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "client write closed",
            ));
        }
        offset += written;
    }
    Ok(())
}

impl Relay {
    /// Must be called with the routing mutex held, making request admission and client
    /// cleanup one ordering boundary. The pipe writer is a different thread.
    fn enqueue(&self, bytes: Vec<u8>, cleanup: bool) -> bool {
        if !cleanup
            && (self.input_count.load(Ordering::Acquire) >= MAX_INPUT_QUEUED
                || self
                    .input_bytes
                    .load(Ordering::Acquire)
                    .saturating_add(bytes.len())
                    > MAX_QUEUE_BYTES)
        {
            return false;
        }
        let size = bytes.len();
        self.input_count.fetch_add(1, Ordering::AcqRel);
        self.input_bytes.fetch_add(size, Ordering::AcqRel);
        if self.input.try_send(bytes).is_err() {
            self.input_count.fetch_sub(1, Ordering::AcqRel);
            self.input_bytes.fetch_sub(size, Ordering::AcqRel);
            return false;
        }
        true
    }

    fn disconnect(&self, epoch: u64) {
        let Ok(mut state) = self.routing.lock() else {
            return;
        };
        if state
            .active
            .as_ref()
            .is_none_or(|client| client.epoch != epoch)
        {
            return;
        }
        let client = state.active.take().unwrap();
        let _ = client.socket.shutdown(Shutdown::Both);
        state.owners.retain(|_, owner| *owner != epoch);
        if !client.gadget_generations.is_empty()
            && !self.enqueue(
                frame(json!({"operation":"control","action":"revokeGadgets",
                "generations":client.gadget_generations,"requestId":format!("core-revoke-{epoch}"),
                "deadlineAt":core_lease::now_ms()+30_000})),
                true,
            )
        {
            // A lost revocation cannot leave a disconnected runtime authorized. Ending
            // the worker is fail-closed; already started effects retain unknown receipts.
            self.stopping.store(true, Ordering::Release);
        }
        // Reserved slots: at most 32 admitted frames, one revoke batch, 16 closes.
        // Enqueuing under the same mutex ensures every admitted open precedes its close.
        for session in client.history {
            let id = format!("core-cleanup-{epoch}-{session}");
            if !self.enqueue(frame(json!({"operation":"historyRead","action":"close",
                "session":session,"requestId":id,"deadlineAt":core_lease::now_ms()+30_000,"lane":"history"})), true) {
                // Losing cleanup is not safe: retire this generation instead of leaking
                // snapshots indefinitely. Worker ownership still fences replacement.
                self.stopping.store(true, Ordering::Release);
            }
        }
    }

    fn deliver(&self, bytes: Vec<u8>, value: &Value) {
        let mut failed = None;
        if let Ok(mut state) = self.routing.lock() {
            let owner = value
                .get("replyId")
                .or_else(|| value.get("historyRequestId"))
                .and_then(Value::as_str)
                .and_then(|id| state.owners.remove(id));
            if let Some(client) = state.active.as_ref() {
                // Capability startup notices are replayed at connect. Unsolicited watch
                // notices may be delivered, but a reply always belongs to its old caller.
                let notice = value.get("dotsFileWatches").is_some();
                if owner == Some(client.epoch) || notice {
                    let size = bytes.len();
                    if client
                        .queued_bytes
                        .load(Ordering::Acquire)
                        .saturating_add(size)
                        > MAX_QUEUE_BYTES
                    {
                        failed = Some(client.epoch);
                    } else {
                        client.queued_bytes.fetch_add(size, Ordering::AcqRel);
                        if client.output.try_send(bytes).is_err() {
                            client.queued_bytes.fetch_sub(size, Ordering::AcqRel);
                            failed = Some(client.epoch);
                        }
                    }
                }
            }
        }
        if let Some(epoch) = failed {
            self.disconnect(epoch);
        }
    }

    fn admit(&self, epoch: u64, bytes: Vec<u8>, value: &Value) -> bool {
        let Some(id) = value
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return false;
        };
        let Ok(mut state) = self.routing.lock() else {
            return false;
        };
        if state
            .active
            .as_ref()
            .is_none_or(|client| client.epoch != epoch)
            || state.owners.len() >= MAX_PENDING
            || state.owners.contains_key(id)
        {
            return false;
        }
        let history = value.get("operation").and_then(Value::as_str) == Some("historyRead");
        let session = value.get("session").and_then(Value::as_str);
        let action = value.get("action").and_then(Value::as_str);
        let generation = if value.get("operation").and_then(Value::as_str) == Some("gadgetState") {
            value
                .pointer("/request/authorization/generation")
                .and_then(Value::as_str)
        } else {
            None
        };
        if let Some(generation) = generation {
            let generations = &state.active.as_ref().unwrap().gadget_generations;
            if generation.len() > 128
                || (!generations.contains(generation) && generations.len() >= 8192)
            {
                return false;
            }
        }
        if history
            && action == Some("open")
            && (session.is_none() || state.active.as_ref().unwrap().history.len() >= 16)
        {
            return false;
        }
        if !self.enqueue(bytes, false) {
            return false;
        }
        state.owners.insert(id.to_owned(), epoch);
        if let Some(generation) = generation {
            state
                .active
                .as_mut()
                .unwrap()
                .gadget_generations
                .insert(generation.to_owned());
        }
        if history && let Some(session) = session {
            let sessions = &mut state.active.as_mut().unwrap().history;
            if action == Some("open") {
                sessions.insert(session.to_owned());
            }
            // A close is already ordered behind its open in the worker input stream.
            if action == Some("close") {
                sessions.remove(session);
            }
        }
        true
    }
}

fn relay_worker_input(
    mut input: ChildStdin,
    rx: mpsc::Receiver<Vec<u8>>,
    count: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
    finished: mpsc::Sender<()>,
) {
    thread::spawn(move || {
        for line in rx {
            count.fetch_sub(1, Ordering::AcqRel);
            bytes.fetch_sub(line.len(), Ordering::AcqRel);
            if input.write_all(&line).is_err() || input.flush().is_err() {
                break;
            }
        }
        let _ = finished.send(());
    });
}

fn relay_worker_output(
    output: impl Read + Send + 'static,
    relay: Arc<Relay>,
    ready: mpsc::SyncSender<Value>,
    finished: mpsc::Sender<()>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(output);
        while let Ok(Some(bytes)) = read_frame(&mut reader, MAX_FRAME) {
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                break;
            };
            if value.get("coreWorkerReady") == Some(&Value::Bool(true)) {
                let _ = ready.try_send(value);
            } else {
                relay.deliver(bytes, &value);
            }
        }
        let _ = finished.send(());
    });
}

fn read_handshake(stream: &mut TcpStream, expected: &[u8]) -> io::Result<bool> {
    let deadline = Instant::now() + HANDSHAKE_DEADLINE;
    let mut bytes = Vec::with_capacity(expected.len());
    while bytes.len() < 128 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "handshake timeout"))?;
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(bytes == expected);
        }
    }
    Ok(false)
}

fn accept_client(
    listener: &TcpListener,
    token: &str,
    generation: &str,
    binary_hash: &str,
    worker_pid: u32,
    relay: &Arc<Relay>,
) {
    let (mut stream, address) = match listener.accept() {
        Ok(value) => value,
        Err(_) => return,
    };
    if !address.ip().is_loopback() {
        return;
    }
    if relay.handshakes.fetch_add(1, Ordering::AcqRel) >= MAX_HANDSHAKES {
        relay.handshakes.fetch_sub(1, Ordering::AcqRel);
        return;
    }
    let relay = Arc::clone(relay);
    let expected = format!("hello {token}\n").into_bytes();
    let generation = generation.to_owned();
    let binary_hash = binary_hash.to_owned();
    thread::spawn(move || {
        let accepted = stream
            .set_nonblocking(false)
            .and_then(|()| stream.set_nodelay(true))
            .and_then(|()| read_handshake(&mut stream, &expected))
            .unwrap_or(false);
        relay.handshakes.fetch_sub(1, Ordering::AcqRel);
        if !accepted {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
        let _ = stream.set_read_timeout(None);
        let epoch = relay.next_epoch.fetch_add(1, Ordering::AcqRel);
        let (output, rx) = mpsc::sync_channel::<Vec<u8>>(8);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let mut writer = match stream.try_clone() {
            Ok(value) => value,
            Err(_) => return,
        };
        {
            let Ok(mut state) = relay.routing.lock() else {
                return;
            };
            if state.active.is_some() || relay.stopping.load(Ordering::Acquire) {
                drop(state);
                let _ = write_frame(&mut writer, &frame(json!({"coreRejected":"busy"})));
                return;
            }
            let socket = match stream.try_clone() {
                Ok(value) => value,
                Err(_) => return,
            };
            state.active = Some(ActiveClient {
                epoch,
                output,
                queued_bytes: queued_bytes.clone(),
                socket,
                history: HashSet::new(),
                gadget_generations: HashSet::new(),
            });
        }
        let writer_relay = Arc::clone(&relay);
        thread::spawn(move || {
            let ack = frame(
                json!({"coreConnected":true,"generation":generation,"binaryHash":binary_hash,"workerPid":worker_pid,"protocol":core_lease::PROTOCOL,"historyReady":true}),
            );
            if write_frame(&mut writer, &ack).is_ok() {
                for bytes in rx {
                    queued_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
                    if write_frame(&mut writer, &bytes).is_err() {
                        break;
                    }
                }
            }
            writer_relay.disconnect(epoch);
        });
        let mut reader = BufReader::new(stream);
        while let Ok(Some(bytes)) = read_frame(&mut reader, MAX_FRAME) {
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                break;
            };
            if value.get("operation").and_then(Value::as_str) == Some("coreShutdown") {
                relay.stopping.store(true, Ordering::Release);
                break;
            }
            if !relay.admit(epoch, bytes, &value) {
                break;
            }
        }
        relay.disconnect(epoch);
    });
}

fn stop_worker(worker: &mut Child) -> crate::Result<()> {
    if worker.try_wait()?.is_some() {
        return Ok(());
    }
    worker.kill()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if worker.try_wait()?.is_some() {
            return Ok(());
        }
        thread::sleep(POLL);
    }
    Err("core worker did not exit after termination; its OS guard still fences takeover".into())
}

pub fn run(data_dir: &Path, db_path: &Path) -> crate::Result<()> {
    let mut lease = Lease::acquire(data_dir, db_path)?;
    let executable = std::env::current_exe()?;
    let binary_hash = core_lease::binary_hash(&executable)?;
    let token = core_lease::random_token();
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    listener.set_nonblocking(true)?;
    let mut worker = Command::new(executable)
        .arg(db_path)
        .env(core_lease::DATA_DIRECTORY_ENV, lease.directory())
        .env(core_lease::GENERATION_ENV, lease.nonce())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    lease.handoff_worker();
    let result = (|| -> crate::Result<()> {
        let input = worker.stdin.take().ok_or("worker stdin unavailable")?;
        let output = worker.stdout.take().ok_or("worker stdout unavailable")?;
        let (tx, rx) = mpsc::sync_channel(64);
        let input_count = Arc::new(AtomicUsize::new(0));
        let input_bytes = Arc::new(AtomicUsize::new(0));
        let relay = Arc::new(Relay {
            routing: Mutex::new(Routing::default()),
            input: tx,
            input_count: input_count.clone(),
            input_bytes: input_bytes.clone(),
            handshakes: AtomicUsize::new(0),
            next_epoch: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
        });
        let (finished, worker_finished) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        relay_worker_input(input, rx, input_count, input_bytes, finished.clone());
        relay_worker_output(output, relay.clone(), ready_tx, finished);
        let ready = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "core worker did not become ready")?;
        if ready.get("generation").and_then(Value::as_str) != Some(lease.nonce())
            || ready.get("workerPid").and_then(Value::as_u64) != Some(worker.id().into())
            || ready.get("protocol").and_then(Value::as_u64) != Some(core_lease::PROTOCOL.into())
        {
            return Err("core worker ownership handshake mismatch".into());
        }
        let endpoint = lease.publish(&listener, &token, db_path, worker.id(), &binary_hash)?;
        eprintln!(
            "[core] supervising {} on 127.0.0.1:{} (pid {}, worker {})",
            data_dir.display(),
            endpoint.port,
            endpoint.pid,
            endpoint.worker_pid
        );
        let outcome = loop {
            if relay.stopping.load(Ordering::Acquire) {
                break Ok(());
            }
            if worker_finished.try_recv().is_ok() {
                break Err("core worker transport ended".into());
            }
            if let Some(status) = worker.try_wait()? {
                break Err(format!("core worker exited: {status}").into());
            }
            accept_client(
                &listener,
                &token,
                lease.nonce(),
                &binary_hash,
                worker.id(),
                &relay,
            );
            thread::sleep(POLL);
        };
        relay.stopping.store(true, Ordering::Release);
        let epoch = relay
            .routing
            .lock()
            .ok()
            .and_then(|state| state.active.as_ref().map(|client| client.epoch));
        if let Some(epoch) = epoch {
            relay.disconnect(epoch);
        }
        outcome
    })();
    let stopped = stop_worker(&mut worker);
    drop(lease);
    result.and(stopped)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_reader_never_returns_partial_or_oversize_json() {
        assert_eq!(
            read_frame(&mut io::Cursor::new(b"one\ntwo\n"), 4).unwrap(),
            Some(b"one\n".to_vec())
        );
        assert!(read_frame(&mut io::Cursor::new(b"missing newline"), 100).is_err());
        assert!(read_frame(&mut io::Cursor::new(b"too long\n"), 4).is_err());
    }
}
