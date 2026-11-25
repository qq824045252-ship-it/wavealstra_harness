//! Supervisor mode: the worker keeps running when its UI client disconnects.
//!
//! This process owns the data directory (see `core_lease`), spawns the real worker, and
//! relays bytes between a loopback client and the worker's stdio. It deliberately knows
//! nothing about the request/reply protocol: it copies lines through untouched, so the
//! worker's own framing (`replyId`, lane flags, unsolicited notices) stays authoritative.

use crate::core_lease::{self, Lease};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::Path,
    process::{ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

/// The worker has a single request stream, so a second client would interleave replies.
const ACCEPT_POLL: Duration = Duration::from_millis(25);

type SharedStdin = Arc<Mutex<ChildStdin>>;
type ClientSink = Arc<Mutex<Option<TcpStream>>>;

struct Relay {
    stdin: SharedStdin,
    sink: ClientSink,
    /// A client is connected right now; new connections are refused, not merged.
    active: Arc<AtomicBool>,
}

impl Relay {
    fn disconnect(&self) {
        if let Ok(mut guard) = self.sink.lock() {
            *guard = None;
        }
        self.active.store(false, Ordering::SeqCst);
    }
}

/// Forwards the worker's stdout to whichever client is connected; drops output for nobody.
fn relay_worker_output(mut output: impl Read + Send + 'static, sink: ClientSink, finished: mpsc::Sender<()>) {
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match output.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut guard = match sink.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    if let Some(stream) = guard.as_mut()
                        && stream.write_all(&buffer[..count]).is_err()
                    {
                        *guard = None;
                    }
                }
            }
        }
        let _ = finished.send(());
    });
}

/// Feeds one client into the worker until that client goes away. The worker's stdin stays
/// open: dropping it would end the worker, which is exactly what this mode exists to avoid.
fn relay_client_input(client: impl Read + Send + 'static, relay: Arc<Relay>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(client);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let mut stdin = match relay.stdin.lock() {
                        Ok(stdin) => stdin,
                        Err(_) => break,
                    };
                    if stdin.write_all(&line).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
            }
        }
        relay.disconnect();
    });
}

fn accept_client(listener: &TcpListener, token: &str, relay: &Arc<Relay>) {
    let (stream, address) = match listener.accept() {
        Ok(accepted) => accepted,
        Err(_) => return,
    };
    if !address.ip().is_loopback() {
        return;
    }
    // The listener is non-blocking so the accept loop can watch the worker; the connection
    // itself must block, or every read would look like end-of-input.
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_nodelay(true);
    // One client at a time; a second one is dropped before it can interleave.
    if relay.active.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => {
            relay.disconnect();
            return;
        }
    });
    let mut handshake = Vec::new();
    let accepted = match reader.read_until(b'\n', &mut handshake) {
        Ok(count) if count > 0 => handshake == format!("hello {token}\n").into_bytes(),
        _ => false,
    };
    if !accepted {
        relay.disconnect();
        return;
    }
    if let Ok(mut guard) = relay.sink.lock() {
        *guard = Some(stream);
    }
    // `reader` still holds whatever the client pipelined after the handshake line.
    relay_client_input(reader, Arc::clone(relay));
}

pub fn run(data_dir: &Path, db_path: &Path) -> crate::Result<()> {
    let lease = Lease::acquire(data_dir, db_path).map_err(|error| error.to_string())?;
    let token = core_lease::random_token();
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    listener.set_nonblocking(true)?;
    let endpoint = lease
        .publish(&listener, &token, db_path)
        .map_err(|error| error.to_string())?;
    eprintln!(
        "[core] supervising {} on 127.0.0.1:{} (pid {})",
        data_dir.display(),
        endpoint.port,
        endpoint.pid
    );

    let executable = std::env::current_exe()?;
    let mut worker = Command::new(executable)
        .arg(db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = worker.stdin.take().ok_or("worker stdin unavailable")?;
    let stdout = worker.stdout.take().ok_or("worker stdout unavailable")?;
    let relay = Arc::new(Relay {
        stdin: Arc::new(Mutex::new(stdin)),
        sink: Arc::new(Mutex::new(None)),
        active: Arc::new(AtomicBool::new(false)),
    });
    let (finished, worker_finished) = mpsc::channel();
    relay_worker_output(stdout, Arc::clone(&relay.sink), finished);

    loop {
        if worker_finished.try_recv().is_ok() {
            break;
        }
        if matches!(worker.try_wait(), Ok(Some(_))) {
            break;
        }
        accept_client(&listener, &token, &relay);
        thread::sleep(ACCEPT_POLL);
    }

    let _ = worker.kill();
    let _ = worker.wait();
    drop(lease);
    Ok(())
}
