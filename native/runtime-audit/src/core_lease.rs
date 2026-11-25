//! Data-directory ownership for a core process that outlives its UI client.
//!
//! The lease says "one core owns this data directory"; the endpoint file says "and it is
//! reachable here". Liveness is decided by trying to connect to the recorded port, so a
//! crashed core is recovered without guessing from timestamps or process ids.

use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LEASE_FILE: &str = "core.lease";
const ENDPOINT_FILE: &str = "core.json";

/// Where a running core listens, and the token a client must present.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub started_at: u64,
    pub db_path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRecord {
    pid: u32,
    nonce: String,
    started_at: u64,
    db_path: String,
}

/// Owns the lease until dropped. Removing the files is best effort: a crash leaves them
/// behind on purpose, and the next core takes them over after the connect probe fails.
#[derive(Debug)]
pub struct Lease {
    directory: PathBuf,
    nonce: String,
    released: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// A local control token, not a cryptographic secret: it only separates this user's
/// processes on loopback, and it never leaves the data directory.
pub fn random_token() -> String {
    let mut value = 0xcbf2_9ce4_8422_2325_u64;
    let seed = (
        std::process::id(),
        now_ms(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0),
        &value as *const u64 as usize,
    );
    for attempt in 0..2 {
        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        attempt.hash(&mut hasher);
        value = hasher.finish() ^ value.rotate_left(17);
    }
    format!("{value:016x}{:016x}", value.rotate_left(32))
}

pub fn endpoint_path(directory: &Path) -> PathBuf {
    directory.join(ENDPOINT_FILE)
}

pub fn read_endpoint(directory: &Path) -> Option<Endpoint> {
    let text = fs::read_to_string(endpoint_path(directory)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn endpoint_alive(endpoint: &Endpoint) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok()
}

fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("flush {}: {error}", path.display()))
}

impl Lease {
    /// Take the data directory, replacing a lease whose core is no longer reachable.
    pub fn acquire(directory: &Path, db_path: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory)
            .map_err(|error| format!("create {}: {error}", directory.display()))?;
        let lease_path = directory.join(LEASE_FILE);
        let db_path = db_path.to_string_lossy().into_owned();
        for attempt in 0..3 {
            let nonce = random_token();
            let record = LeaseRecord {
                pid: std::process::id(),
                nonce: nonce.clone(),
                started_at: now_ms(),
                db_path: db_path.clone(),
            };
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&lease_path) {
                Ok(mut file) => {
                    let serialized = serde_json::to_string(&record).map_err(|error| error.to_string())?;
                    file.write_all(serialized.as_bytes())
                        .map_err(|error| format!("write {}: {error}", lease_path.display()))?;
                    file.sync_all()
                        .map_err(|error| format!("flush {}: {error}", lease_path.display()))?;
                    return Ok(Lease {
                        directory: directory.to_path_buf(),
                        nonce,
                        released: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A previous core crashed without cleaning up: its endpoint no longer
                    // accepts connections, so the directory is free.
                    if read_endpoint(directory).is_some_and(|endpoint| endpoint_alive(&endpoint)) {
                        return Err(format!("core already running for {}", directory.display()));
                    }
                    let _ = fs::remove_file(endpoint_path(directory));
                    let _ = fs::remove_file(&lease_path);
                    if attempt >= 2 {
                        return Err(format!("could not take {}", lease_path.display()));
                    }
                }
                Err(error) => return Err(format!("create {}: {error}", lease_path.display())),
            }
        }
        Err(format!("could not take {}", lease_path.display()))
    }

    #[cfg(test)]
    pub fn nonce(&self) -> &str {
        &self.nonce
    }

    /// Publish the endpoint once the listener is bound. Clients treat this file as the
    /// single source of truth for "a core is ready".
    pub fn publish(&self, listener: &TcpListener, token: &str, db_path: &Path) -> Result<Endpoint, String> {
        let port = listener
            .local_addr()
            .map_err(|error| format!("local_addr: {error}"))?
            .port();
        let endpoint = Endpoint {
            pid: std::process::id(),
            port,
            token: token.to_owned(),
            started_at: now_ms(),
            db_path: db_path.to_string_lossy().into_owned(),
        };
        let path = endpoint_path(&self.directory);
        let staging = path.with_extension("json.tmp");
        let serialized = serde_json::to_string(&endpoint).map_err(|error| error.to_string())?;
        write_private(&staging, &serialized)?;
        fs::rename(&staging, &path).map_err(|error| format!("rename {}: {error}", path.display()))?;
        Ok(endpoint)
    }

    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        // Only remove what is still ours: another core may have taken over already.
        if fs::read_to_string(self.directory.join(LEASE_FILE))
            .ok()
            .and_then(|text| serde_json::from_str::<LeaseRecord>(&text).ok())
            .is_some_and(|record| record.nonce == self.nonce)
        {
            let _ = fs::remove_file(endpoint_path(&self.directory));
            let _ = fs::remove_file(self.directory.join(LEASE_FILE));
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> Fixture {
        // Tests in one binary run in parallel: the name has to be unique per fixture, not
        // just per process, or one test removes the directory another one is still using.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "mybuddy-core-lease-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("create fixture");
        Fixture(root)
    }

    #[test]
    fn a_reachable_core_keeps_its_lease() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let lease = Lease::acquire(&fixture.0, &fixture.0.join("app.db")).expect("first lease");
        lease.publish(&listener, "token-1", &fixture.0.join("app.db")).expect("publish");
        assert_eq!(read_endpoint(&fixture.0).expect("endpoint").token, "token-1");
        let error = Lease::acquire(&fixture.0, &fixture.0.join("app.db")).expect_err("second must fail");
        assert!(error.contains("already running"), "{error}");
        drop(listener);
    }

    #[test]
    fn an_unreachable_core_is_replaced() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let endpoint = Endpoint {
            pid: 1,
            port,
            token: "stale".to_owned(),
            started_at: 1,
            db_path: "app.db".to_owned(),
        };
        write_private(
            &endpoint_path(&fixture.0),
            &serde_json::to_string(&endpoint).expect("serialize"),
        )
        .expect("write endpoint");
        write_private(
            &fixture.0.join(LEASE_FILE),
            r#"{"pid":1,"nonce":"stale","startedAt":1,"dbPath":"app.db"}"#,
        )
        .expect("write lease");
        let lease = Lease::acquire(&fixture.0, &fixture.0.join("app.db")).expect("take over");
        assert_ne!(lease.nonce(), "stale");
    }

    #[test]
    fn releasing_removes_both_files_and_only_once() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let mut lease = Lease::acquire(&fixture.0, &fixture.0.join("app.db")).expect("lease");
        lease.publish(&listener, "token", &fixture.0.join("app.db")).expect("publish");
        assert!(endpoint_path(&fixture.0).exists());
        lease.release();
        assert!(!endpoint_path(&fixture.0).exists());
        assert!(!fixture.0.join(LEASE_FILE).exists());
        lease.release();
        assert_eq!(random_token().len(), 32);
        assert_ne!(random_token(), random_token());
    }
}
