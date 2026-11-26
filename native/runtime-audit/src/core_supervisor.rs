//! A Core owns its worker independently of any UI connection. Network I/O never runs
//! on the supervisor loop or while holding its routing mutex. Every queue is bounded,
//! connections are role-scoped, and control/event notifications do not share bulk data capacity.
use crate::core_lease::{self, CoreStatus, Lease};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Condvar, Mutex,
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
const MAX_CLIENTS: usize = 12;
const MAX_UI_CLIENTS: usize = 6;
const MAX_PENDING: usize = 512;
const MAX_FRAME: usize = 32 * 1024 * 1024;
const MAX_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_NOTIFY_QUEUED: usize = 64;
const MAX_DATA_QUEUED: usize = 16;
const MAX_INPUT_QUEUED: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
enum ClientRole {
    LegacyExclusive,
    Ui,
    ExecutionHost,
    BackgroundService,
}

impl ClientRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::LegacyExclusive => "legacy",
            Self::Ui => "ui",
            Self::ExecutionHost => "execution-host",
            Self::BackgroundService => "background-service",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ui" => Some(Self::Ui),
            "execution-host" => Some(Self::ExecutionHost),
            "background-service" => Some(Self::BackgroundService),
            _ => None,
        }
    }
}

#[derive(Default)]
struct ClientQueues {
    notify: VecDeque<Vec<u8>>,
    data: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

struct PriorityOutput {
    state: Mutex<ClientQueues>,
    ready: Condvar,
}

impl PriorityOutput {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ClientQueues::default()),
            ready: Condvar::new(),
        })
    }

    fn push(&self, bytes: Vec<u8>, notify: bool) -> bool {
        let Ok(mut guard) = self.state.lock() else {
            return false;
        };
        if guard.closed || guard.bytes.saturating_add(bytes.len()) > MAX_QUEUE_BYTES {
            return false;
        }
        if notify {
            if guard.notify.len() >= MAX_NOTIFY_QUEUED {
                return false;
            }
            guard.bytes += bytes.len();
            guard.notify.push_back(bytes);
        } else {
            if guard.data.len() >= MAX_DATA_QUEUED {
                return false;
            }
            guard.bytes += bytes.len();
            guard.data.push_back(bytes);
        }
        self.ready.notify_one();
        true
    }

    fn pop(&self) -> Option<Vec<u8>> {
        let mut guard = self.state.lock().ok()?;
        loop {
            if let Some(frame) = guard.notify.pop_front() {
                guard.bytes = guard.bytes.saturating_sub(frame.len());
                return Some(frame);
            }
            if let Some(frame) = guard.data.pop_front() {
                guard.bytes = guard.bytes.saturating_sub(frame.len());
                return Some(frame);
            }
            if guard.closed {
                return None;
            }
            guard = self.ready.wait(guard).ok()?;
        }
    }

    fn close(&self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.closed = true;
            self.ready.notify_all();
        }
    }
}

#[derive(Clone, Debug)]
struct EventSubscription {
    core_generation: String,
    last_seq: i64,
}

struct ActiveClient {
    epoch: u64,
    role: ClientRole,
    client_id: String,
    output: Arc<PriorityOutput>,
    socket: TcpStream,
    history: HashSet<String>,
    gadget_generations: HashSet<String>,
    subscribed: Option<EventSubscription>,
}

#[derive(Default)]
struct Routing {
    clients: HashMap<u64, ActiveClient>,
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
    explicit_stop: AtomicBool,
    generation: String,
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
        let Some(client) = state.clients.remove(&epoch) else {
            return;
        };
        client.output.close();
        let _ = client.socket.shutdown(Shutdown::Both);
        state.owners.retain(|_, owner| *owner != epoch);
        // Only clean up resources belonging to this specific connection. A disconnected
        // UI connection must NEVER revoke background-service or execution-host leases.
        if !client.gadget_generations.is_empty()
            && !self.enqueue(
                frame(json!({
                    "operation": "control",
                    "action": "revokeGadgets",
                    "generations": client.gadget_generations,
                    "requestId": format!("core-revoke-{epoch}"),
                    "deadlineAt": core_lease::now_ms() + 30_000
                })),
                true,
            )
        {
            self.stopping.store(true, Ordering::Release);
        }
        for session in client.history {
            let id = format!("core-cleanup-{epoch}-{session}");
            if !self.enqueue(
                frame(json!({
                    "operation": "historyRead",
                    "action": "close",
                    "session": session,
                    "requestId": id,
                    "deadlineAt": core_lease::now_ms() + 30_000,
                    "lane": "history"
                })),
                true,
            ) {
                self.stopping.store(true, Ordering::Release);
            }
        }
        if client.role == ClientRole::ExecutionHost {
            let _ = self.enqueue(
                frame(json!({
                    "operation": "coreExecutorPresence",
                    "online": false,
                    "epoch": epoch,
                    "clientId": client.client_id,
                    "generation": self.generation,
                    "requestId": format!("core-exec-offline-{epoch}"),
                    "deadlineAt": core_lease::now_ms() + 30_000
                })),
                true,
            );
        }
    }

    fn deliver(&self, bytes: Vec<u8>, value: &Value) {
        if value.get("coreShutdownRequested").and_then(Value::as_bool) == Some(true) {
            self.explicit_stop.store(true, Ordering::Release);
            self.stopping.store(true, Ordering::Release);
            return;
        }
        let mut failed_epochs: Vec<u64> = Vec::new();
        if let Ok(mut state) = self.routing.lock() {
            if let Some(event) = value.get("coreEvent") {
                let seq = event.get("seq").and_then(Value::as_i64).unwrap_or(0);
                let event_gen = event
                    .get("coreGeneration")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                for client in state.clients.values_mut() {
                    if let Some(sub) = client.subscribed.as_mut()
                        && sub.core_generation == event_gen
                        && seq > sub.last_seq
                    {
                        if client.output.push(bytes.clone(), true) {
                            sub.last_seq = seq;
                        } else {
                            failed_epochs.push(client.epoch);
                        }
                    }
                }
            } else if let Some(dispatch) = value.get("coreExecutionDispatch") {
                let target_epoch = dispatch.get("targetEpoch").and_then(Value::as_u64);
                for client in state.clients.values() {
                    if client.role == ClientRole::ExecutionHost
                        && target_epoch.is_none_or(|e| e == client.epoch)
                        && !client.output.push(bytes.clone(), true)
                    {
                        failed_epochs.push(client.epoch);
                    }
                }
            } else {
                let owner = value
                    .get("replyId")
                    .or_else(|| value.get("historyRequestId"))
                    .and_then(Value::as_str)
                    .and_then(|id| state.owners.remove(id));
                let notice = value.get("dotsFileWatches").is_some();
                if notice {
                    for client in state.clients.values() {
                        if matches!(
                            client.role,
                            ClientRole::LegacyExclusive
                                | ClientRole::Ui
                                | ClientRole::BackgroundService
                        ) && !client.output.push(bytes.clone(), true)
                        {
                            failed_epochs.push(client.epoch);
                        }
                    }
                } else if let Some(owner_epoch) = owner
                    && let Some(client) = state.clients.get(&owner_epoch)
                {
                    if !client.output.push(bytes, false) {
                        failed_epochs.push(owner_epoch);
                    }
                }
            }
        }
        for epoch in failed_epochs {
            self.disconnect(epoch);
        }
    }

    fn handle_subscribe(&self, epoch: u64, value: &Value) -> bool {
        let Some(id) = value.get("requestId").and_then(Value::as_str) else {
            return false;
        };
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("subscribe");
        let reply = if action == "unsubscribe" {
            if let Ok(mut state) = self.routing.lock()
                && let Some(client) = state.clients.get_mut(&epoch)
            {
                client.subscribed = None;
            }
            json!({ "replyId": id, "status": "ok", "data": { "subscribed": false } })
        } else {
            let core_gen = value
                .get("coreGeneration")
                .and_then(Value::as_str)
                .unwrap_or(&self.generation)
                .to_owned();
            let after_seq = value.get("afterSeq").and_then(Value::as_i64).unwrap_or(0);
            if let Ok(mut state) = self.routing.lock()
                && let Some(client) = state.clients.get_mut(&epoch)
            {
                client.subscribed = Some(EventSubscription {
                    core_generation: core_gen.clone(),
                    last_seq: after_seq,
                });
            }
            json!({
                "replyId": id,
                "status": "ok",
                "data": { "subscribed": true, "coreGeneration": core_gen, "afterSeq": after_seq }
            })
        };
        let mut disconnect = false;
        if let Ok(state) = self.routing.lock()
            && let Some(client) = state.clients.get(&epoch)
        {
            if !client.output.push(frame(reply), true) {
                disconnect = true;
            }
        }
        if disconnect {
            self.disconnect(epoch);
            return false;
        }
        true
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
        if state.owners.len() >= MAX_PENDING || state.owners.contains_key(id) {
            return false;
        }
        let Some(client) = state.clients.get(&epoch) else {
            return false;
        };
        let history = value.get("operation").and_then(Value::as_str) == Some("historyRead");
        let session = value.get("session").and_then(Value::as_str);
        let action = value.get("action").and_then(Value::as_str);
        let generation = if value.get("operation").and_then(Value::as_str) == Some("gadgetState") {
            let is_ui_owned = client.role == ClientRole::LegacyExclusive
                || value
                    .pointer("/request/authorization/ownerScope")
                    .and_then(Value::as_str)
                    == Some("ui");
            if is_ui_owned {
                value
                    .pointer("/request/authorization/generation")
                    .and_then(Value::as_str)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(generation) = generation {
            let generations = &client.gadget_generations;
            if generation.len() > 128
                || (!generations.contains(generation) && generations.len() >= 8192)
            {
                return false;
            }
        }
        if history && action == Some("open") && (session.is_none() || client.history.len() >= 16) {
            return false;
        }
        // Authenticate sender role, clientId, epoch, and generation from supervisor state,
        // overwriting any caller-supplied `__client`.
        let enriched_bytes = if let Some(mut map) = value.as_object().cloned() {
            map.insert(
                "__client".to_owned(),
                json!({
                    "epoch": client.epoch,
                    "role": client.role.as_str(),
                    "clientId": client.client_id,
                    "generation": self.generation,
                }),
            );
            frame(Value::Object(map))
        } else {
            bytes
        };
        if !self.enqueue(enriched_bytes, false) {
            return false;
        }
        state.owners.insert(id.to_owned(), epoch);
        let client_mut = state.clients.get_mut(&epoch).unwrap();
        if let Some(generation) = generation {
            client_mut.gadget_generations.insert(generation.to_owned());
        }
        if history && let Some(session) = session {
            if action == Some("open") {
                client_mut.history.insert(session.to_owned());
            }
            if action == Some("close") {
                client_mut.history.remove(session);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeOptions {
    role: String,
    client_id: Option<String>,
}

struct ParsedHandshake {
    role: ClientRole,
    client_id: String,
    legacy: bool,
}

fn read_handshake(stream: &mut TcpStream, token: &str) -> io::Result<Option<ParsedHandshake>> {
    let deadline = Instant::now() + HANDSHAKE_DEADLINE;
    let mut bytes = Vec::with_capacity(128);
    while bytes.len() < 1024 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "handshake timeout"))?;
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "utf8"))?;
            let prefix = format!("hello {token}");
            if line == prefix {
                return Ok(Some(ParsedHandshake {
                    role: ClientRole::LegacyExclusive,
                    client_id: "legacy".to_owned(),
                    legacy: true,
                }));
            }
            if let Some(rest) = line.strip_prefix(&format!("{prefix} ")) {
                let Ok(opts) = serde_json::from_str::<HandshakeOptions>(rest.trim()) else {
                    return Ok(None);
                };
                let Some(role) = ClientRole::parse(&opts.role) else {
                    return Ok(None);
                };
                let client_id = opts
                    .client_id
                    .filter(|s| !s.trim().is_empty() && s.len() <= 128)
                    .unwrap_or_else(|| format!("{}-client", role.as_str()));
                return Ok(Some(ParsedHandshake {
                    role,
                    client_id,
                    legacy: false,
                }));
            }
            return Ok(None);
        }
        bytes.push(byte[0]);
    }
    Ok(None)
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
    let token = token.to_owned();
    let generation = generation.to_owned();
    let binary_hash = binary_hash.to_owned();
    thread::spawn(move || {
        let parsed = stream
            .set_nonblocking(false)
            .and_then(|()| stream.set_nodelay(true))
            .and_then(|()| read_handshake(&mut stream, &token))
            .unwrap_or(None);
        relay.handshakes.fetch_sub(1, Ordering::AcqRel);
        let Some(handshake) = parsed else {
            let _ = stream.shutdown(Shutdown::Both);
            return;
        };
        let _ = stream.set_read_timeout(None);
        let epoch = relay.next_epoch.fetch_add(1, Ordering::AcqRel);
        let output = PriorityOutput::new();
        let mut writer = match stream.try_clone() {
            Ok(value) => value,
            Err(_) => return,
        };
        {
            let Ok(mut state) = relay.routing.lock() else {
                return;
            };
            if relay.stopping.load(Ordering::Acquire) {
                drop(state);
                let _ = write_frame(&mut writer, &frame(json!({"coreRejected":"stopping"})));
                return;
            }
            if state.clients.len() >= MAX_CLIENTS {
                drop(state);
                let _ = write_frame(&mut writer, &frame(json!({"coreRejected":"busy"})));
                return;
            }
            let conflict = match handshake.role {
                ClientRole::LegacyExclusive => (!state.clients.is_empty()).then_some("busy"),
                ClientRole::Ui => state
                    .clients
                    .values()
                    .any(|c| c.role == ClientRole::LegacyExclusive)
                    .then_some("busy")
                    .or_else(|| {
                        (state
                            .clients
                            .values()
                            .filter(|c| c.role == ClientRole::Ui)
                            .count()
                            >= MAX_UI_CLIENTS)
                            .then_some("too_many_ui_clients")
                    }),
                ClientRole::ExecutionHost | ClientRole::BackgroundService => state
                    .clients
                    .values()
                    .find_map(|c| {
                        if c.role == ClientRole::LegacyExclusive {
                            Some("busy")
                        } else if c.role == handshake.role {
                            Some("role_busy")
                        } else {
                            None
                        }
                    }),
            };
            if let Some(reason) = conflict {
                drop(state);
                let _ = write_frame(&mut writer, &frame(json!({"coreRejected": reason})));
                return;
            }
            let socket = match stream.try_clone() {
                Ok(value) => value,
                Err(_) => return,
            };
            state.clients.insert(
                epoch,
                ActiveClient {
                    epoch,
                    role: handshake.role.clone(),
                    client_id: handshake.client_id.clone(),
                    output: Arc::clone(&output),
                    socket,
                    history: HashSet::new(),
                    gadget_generations: HashSet::new(),
                    subscribed: None,
                },
            );
        }
        if handshake.role == ClientRole::ExecutionHost {
            let _ = relay.enqueue(
                frame(json!({
                    "operation": "coreExecutorPresence",
                    "online": true,
                    "epoch": epoch,
                    "clientId": handshake.client_id,
                    "generation": generation,
                    "requestId": format!("core-exec-online-{epoch}"),
                    "deadlineAt": core_lease::now_ms() + 30_000
                })),
                true,
            );
        }
        let writer_relay = Arc::clone(&relay);
        let ack_role = handshake.role.clone();
        let ack_client_id = handshake.client_id.clone();
        let legacy = handshake.legacy;
        thread::spawn(move || {
            let ack = if legacy {
                json!({
                    "coreConnected": true,
                    "generation": generation,
                    "binaryHash": binary_hash,
                    "workerPid": worker_pid,
                    "protocol": core_lease::PROTOCOL,
                    "historyReady": true
                })
            } else {
                json!({
                    "coreConnected": true,
                    "generation": generation,
                    "binaryHash": binary_hash,
                    "workerPid": worker_pid,
                    "protocol": core_lease::PROTOCOL,
                    "historyReady": true,
                    "role": ack_role.as_str(),
                    "clientId": ack_client_id,
                    "connectionEpoch": epoch
                })
            };
            if write_frame(&mut writer, &frame(ack)).is_ok() {
                while let Some(bytes) = output.pop() {
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
            let op = value.get("operation").and_then(Value::as_str);
            if op == Some("coreShutdown") {
                relay.explicit_stop.store(true, Ordering::Release);
                relay.stopping.store(true, Ordering::Release);
                break;
            }
            if op == Some("coreSubscribe") {
                if !relay.handle_subscribe(epoch, &value) {
                    break;
                }
                continue;
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

fn write_status_best_effort(directory: &Path, status: CoreStatus) {
    let _ = core_lease::write_core_status(directory, &status);
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
        .env("MYBUDDY_CORE_SUPERVISED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    lease.handoff_worker();
    let worker_pid = worker.id();
    let mut explicitly_stopped = false;
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
            explicit_stop: AtomicBool::new(false),
            generation: lease.nonce().to_owned(),
        });
        let (finished, worker_finished) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        relay_worker_input(input, rx, input_count, input_bytes, finished.clone());
        relay_worker_output(output, relay.clone(), ready_tx, finished);
        let ready = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "core worker did not become ready")?;
        if ready.get("generation").and_then(Value::as_str) != Some(lease.nonce())
            || ready.get("workerPid").and_then(Value::as_u64) != Some(worker_pid.into())
            || ready.get("protocol").and_then(Value::as_u64) != Some(core_lease::PROTOCOL.into())
        {
            return Err("core worker ownership handshake mismatch".into());
        }
        let endpoint = lease.publish(&listener, &token, db_path, worker_pid, &binary_hash)?;
        let prev_status = core_lease::read_core_status(lease.directory());
        write_status_best_effort(
            lease.directory(),
            CoreStatus {
                pid: endpoint.pid,
                worker_pid,
                generation: endpoint.generation.clone(),
                state: "running".to_owned(),
                worker_restart_count: prev_status.as_ref().map(|s| s.worker_restart_count).unwrap_or(0),
                consecutive_failures: 0,
                circuit_open: false,
                circuit_reason: None,
                last_worker_exit: None,
                updated_at: core_lease::now_ms(),
            },
        );
        eprintln!(
            "[core] supervising {} on 127.0.0.1:{} (pid {}, worker {})",
            data_dir.display(),
            endpoint.port,
            endpoint.pid,
            endpoint.worker_pid
        );
        let outcome = loop {
            if relay.stopping.load(Ordering::Acquire) {
                explicitly_stopped = relay.explicit_stop.load(Ordering::Acquire);
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
                worker_pid,
                &relay,
            );
            thread::sleep(POLL);
        };
        relay.stopping.store(true, Ordering::Release);
        let epochs: Vec<u64> = relay
            .routing
            .lock()
            .ok()
            .map(|state| state.clients.keys().copied().collect())
            .unwrap_or_default();
        for epoch in epochs {
            relay.disconnect(epoch);
        }
        outcome
    })();
    let stopped = stop_worker(&mut worker);
    let generation = lease.nonce().to_owned();
    let prev = core_lease::read_core_status(lease.directory());
    let restart_count = prev.as_ref().map(|s| s.worker_restart_count).unwrap_or(0);
    if explicitly_stopped {
        write_status_best_effort(
            lease.directory(),
            CoreStatus {
                pid: std::process::id(),
                worker_pid: 0,
                generation,
                state: "stopped".to_owned(),
                worker_restart_count: restart_count,
                consecutive_failures: 0,
                circuit_open: false,
                circuit_reason: None,
                last_worker_exit: Some("explicit_stop".to_owned()),
                updated_at: core_lease::now_ms(),
            },
        );
    } else if let Err(ref error) = result {
        write_status_best_effort(
            lease.directory(),
            CoreStatus {
                pid: std::process::id(),
                worker_pid: 0,
                generation,
                state: "failed".to_owned(),
                worker_restart_count: restart_count,
                consecutive_failures: prev.as_ref().map(|s| s.consecutive_failures + 1).unwrap_or(1),
                circuit_open: false,
                circuit_reason: None,
                last_worker_exit: Some(error.to_string()),
                updated_at: core_lease::now_ms(),
            },
        );
    }
    drop(lease);
    result.and(stopped)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

/// Unattended Core watchdog: keeps `--supervise` running across worker or supervisor crashes
/// with exponential backoff and a bounded crash-streak circuit breaker, while strictly
/// respecting `stopped_explicitly` (`停止助理`) so explicit stops are never auto-restarted.
pub fn run_watchdog(data_dir: &Path, db_path: &Path, recover: bool) -> crate::Result<()> {
    let executable = std::env::current_exe()?;
    std::fs::create_dir_all(data_dir)?;
    let canon_dir = std::fs::canonicalize(data_dir)?;
    if recover {
        let mut lifecycle = core_lease::read_lifecycle_state(&canon_dir);
        lifecycle.mode = "active".to_owned();
        lifecycle.reason = "explicit_recover".to_owned();
        lifecycle.updated_at = core_lease::now_ms();
        core_lease::write_lifecycle_state(&canon_dir, &lifecycle)?;
        if let Some(mut status) = core_lease::read_core_status(&canon_dir) {
            status.circuit_open = false;
            status.circuit_reason = None;
            status.consecutive_failures = 0;
            status.state = "recovering".to_owned();
            status.updated_at = core_lease::now_ms();
            write_status_best_effort(&canon_dir, status);
        }
    }
    let initial_lifecycle = core_lease::read_lifecycle_state(&canon_dir);
    if initial_lifecycle.mode == "stopped_explicitly" {
        return Ok(());
    }
    if core_lease::read_core_status(&canon_dir).is_some_and(|s| s.circuit_open) {
        return Err("core watchdog circuit breaker is open; explicit recovery required".into());
    }

    let base_backoff_ms = env_u64("MYBUDDY_CORE_BACKOFF_MS", 100).max(10);
    let window_ms = env_u64("MYBUDDY_CORE_RESTART_WINDOW_MS", 30_000).max(500);
    let max_restarts = env_u64("MYBUDDY_CORE_MAX_RESTARTS", 5).max(1) as usize;
    let mut failure_times: VecDeque<Instant> = VecDeque::new();
    let mut total_restarts: u32 = core_lease::read_core_status(&canon_dir)
        .map(|s| s.worker_restart_count)
        .unwrap_or(0);

    loop {
        let lifecycle = core_lease::read_lifecycle_state(&canon_dir);
        if lifecycle.mode == "stopped_explicitly" {
            return Ok(());
        }
        let mut child = Command::new(&executable)
            .arg("--supervise")
            .arg(&canon_dir)
            .arg(db_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?;
        let status = child.wait()?;
        let lifecycle_after = core_lease::read_lifecycle_state(&canon_dir);
        if status.success() || lifecycle_after.mode == "stopped_explicitly" {
            return Ok(());
        }
        let now = Instant::now();
        while failure_times
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) > Duration::from_millis(window_ms))
        {
            failure_times.pop_front();
        }
        failure_times.push_back(now);
        if failure_times.len() >= max_restarts {
            write_status_best_effort(
                &canon_dir,
                CoreStatus {
                    pid: std::process::id(),
                    worker_pid: 0,
                    generation: core_lease::read_core_status(&canon_dir)
                        .map(|s| s.generation)
                        .unwrap_or_default(),
                    state: "circuit_open".to_owned(),
                    worker_restart_count: total_restarts,
                    consecutive_failures: failure_times.len() as u32,
                    circuit_open: true,
                    circuit_reason: Some(format!(
                        "exceeded {max_restarts} crashes within {window_ms}ms"
                    )),
                    last_worker_exit: Some(format!("supervisor exit: {status}")),
                    updated_at: core_lease::now_ms(),
                },
            );
            return Err("core watchdog circuit breaker opened".into());
        }
        total_restarts = total_restarts.saturating_add(1);
        let exp = (failure_times.len().saturating_sub(1)).min(5) as u32;
        let delay_ms = base_backoff_ms.saturating_mul(1u64 << exp).min(2_000);
        write_status_best_effort(
            &canon_dir,
            CoreStatus {
                pid: std::process::id(),
                worker_pid: 0,
                generation: core_lease::read_core_status(&canon_dir)
                    .map(|s| s.generation)
                    .unwrap_or_default(),
                state: "restarting".to_owned(),
                worker_restart_count: total_restarts,
                consecutive_failures: failure_times.len() as u32,
                circuit_open: false,
                circuit_reason: None,
                last_worker_exit: Some(format!("supervisor exit: {status}")),
                updated_at: core_lease::now_ms(),
            },
        );
        thread::sleep(Duration::from_millis(delay_ms));
    }
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
