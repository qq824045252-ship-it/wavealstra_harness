//! OS-held ownership of a Core and its worker. Endpoint files are discovery metadata;
//! neither a missing endpoint nor a refused TCP connection proves that a writer died.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{self, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const LEASE_FILE: &str = "core.lease";
const ENDPOINT_FILE: &str = "core.json";
const LIFECYCLE_FILE: &str = "core-lifecycle.json";
const STATUS_FILE: &str = "core-status.json";
const OWNER_LOCK: &str = "core.lock";
const WORKER_LOCK: &str = "core-worker.lock";
pub const DATA_DIRECTORY_ENV: &str = "MYBUDDY_CORE_DATA_DIRECTORY";
pub const GENERATION_ENV: &str = "MYBUDDY_CORE_GENERATION";
pub const PROTOCOL: u32 = 89;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreLifecycleState {
    pub mode: String, // "active" | "stopped_explicitly"
    pub resident_enabled: bool,
    pub autostart_enabled: bool,
    pub reason: String,
    pub updated_at: u64,
}

impl Default for CoreLifecycleState {
    fn default() -> Self {
        Self {
            mode: "active".to_owned(),
            resident_enabled: false,
            autostart_enabled: false,
            reason: "default".to_owned(),
            updated_at: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub pid: u32,
    pub worker_pid: u32,
    pub generation: String,
    pub state: String, // "starting" | "running" | "restarting" | "stopped" | "circuit_open"
    pub worker_restart_count: u32,
    pub consecutive_failures: u32,
    pub circuit_open: bool,
    pub circuit_reason: Option<String>,
    pub last_worker_exit: Option<String>,
    pub updated_at: u64,
}

pub fn read_lifecycle_state(directory: &Path) -> CoreLifecycleState {
    let path = directory.join(LIFECYCLE_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CoreLifecycleState>(&raw).ok())
        .unwrap_or_default()
}

pub fn write_lifecycle_state(directory: &Path, state: &CoreLifecycleState) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| format!("create {}: {e}", directory.display()))?;
    let path = directory.join(LIFECYCLE_FILE);
    let staging = path.with_extension("json.tmp");
    write_private(
        &staging,
        &serde_json::to_string(state).map_err(|e| e.to_string())?,
    )?;
    fs::rename(&staging, &path).map_err(|e| format!("write lifecycle: {e}"))
}

pub fn read_core_status(directory: &Path) -> Option<CoreStatus> {
    let path = directory.join(STATUS_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CoreStatus>(&raw).ok())
}

pub fn write_core_status(directory: &Path, status: &CoreStatus) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| format!("create {}: {e}", directory.display()))?;
    let path = directory.join(STATUS_FILE);
    let staging = path.with_extension("json.tmp");
    write_private(
        &staging,
        &serde_json::to_string(status).map_err(|e| e.to_string())?,
    )?;
    fs::rename(&staging, &path).map_err(|e| format!("write status: {e}"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub pid: u32,
    pub worker_pid: u32,
    pub port: u16,
    pub token: String,
    pub generation: String,
    pub binary_hash: String,
    pub protocol: u32,
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

/// Never unlink OS lock files: that would let another process lock a different inode.
#[derive(Debug)]
pub struct Lease {
    directory: PathBuf,
    nonce: String,
    owner: Option<File>,
    worker_handoff: Option<File>,
}

/// This guard outlives a killed supervisor, fencing replacement writers until exit.
pub struct WorkerLease {
    _guard: File,
    generation: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn random_token() -> String {
    let mut value = 0xcbf2_9ce4_8422_2325_u64;
    let seed = (
        std::process::id(),
        now_ms(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.subsec_nanos())
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

pub fn binary_hash(path: &Path) -> crate::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
pub fn read_endpoint(directory: &Path) -> Option<Endpoint> {
    serde_json::from_str(&fs::read_to_string(endpoint_path(directory)).ok()?).ok()
}

/// A short-lived database initializer holds the very same guards as a Core and its
/// worker. It does not need a DB file and never edits endpoint metadata. Host death
/// closes stdin, automatically releasing both OS locks without a stale-lock heuristic.
pub fn guard_database(directory: &Path) -> crate::Result<()> {
    let (_owner, _worker) = initialization_guards(directory)?;
    {
        let mut out = std::io::stdout().lock();
        serde_json::to_writer(
            &mut out,
            &serde_json::json!({"coreDatabaseGuardReady":true,"pid":std::process::id(),"protocol":PROTOCOL}),
        )?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    let mut buffer = [0; 1024];
    while std::io::stdin().read(&mut buffer)? != 0 {}
    Ok(())
}

pub fn initialization_guards(directory: &Path) -> crate::Result<(File, File)> {
    fs::create_dir_all(directory)?;
    let owner = lock_guard(
        &directory.join(OWNER_LOCK),
        "core already running or owner lock unavailable",
    )?;
    let worker = lock_guard(
        &directory.join(WORKER_LOCK),
        "previous core worker still running or worker lock unavailable",
    )?;
    // A parent may have died after spawn but before its child acquired worker.lock.
    // Rebuilding the DB must invalidate that child's old authorization even after this
    // guard releases. Holding both OS locks makes this metadata change exclusive.
    match fs::remove_file(directory.join(LEASE_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok((owner, worker))
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn open_guard(path: &Path) -> Result<File, String> {
    private_options()
        .open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))
}

fn lock_guard(path: &Path, label: &str) -> Result<File, String> {
    let guard = open_guard(path)?;
    guard
        .try_lock()
        .map_err(|error| format!("{label}: {}: {error}", path.display()))?;
    Ok(guard)
}

// A predecessor can still be unwinding after its parent's pipe closes. Hold the
// owner lock and allow it the same grace period as the child handoff.
fn lock_worker_after_handoff(directory: &Path) -> Result<File, String> {
    let guard = open_guard(&directory.join(WORKER_LOCK))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match guard.try_lock() {
            Ok(()) => return Ok(guard),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("previous core worker still running or worker lock unavailable: {error}")),
        }
    }
}

fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = private_options();
    options.truncate(true);
    let mut file = options
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("flush {}: {error}", path.display()))
}

fn canonical_database_path(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        result => return result,
    }
    match fs::symlink_metadata(path) {
        // A dangling link must fail instead of turning into a new database target.
        Ok(_) => return fs::canonicalize(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let name = path.file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "database path has no file name"))?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    Ok(fs::canonicalize(parent)?.join(name))
}

impl Lease {
    pub fn acquire(directory: &Path, db_path: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory)
            .map_err(|error| format!("create {}: {error}", directory.display()))?;
        let directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
        let owner = lock_guard(
            &directory.join(OWNER_LOCK),
            "core already running or owner lock unavailable",
        )?;
        // No metadata may change until both the old parent and its old worker are gone.
        let worker_handoff = lock_worker_after_handoff(&directory)?;
        let nonce = random_token();
        let record = LeaseRecord {
            pid: std::process::id(),
            nonce: nonce.clone(),
            started_at: now_ms(),
            db_path: canonical_database_path(db_path)
                .map_err(|error| format!("database path: {error}"))?
                .to_string_lossy()
                .into_owned(),
        };
        write_private(
            &directory.join(LEASE_FILE),
            &serde_json::to_string(&record).map_err(|error| error.to_string())?,
        )?;
        match fs::remove_file(endpoint_path(&directory)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("remove stale endpoint: {error}")),
        }
        Ok(Self {
            directory,
            nonce,
            owner: Some(owner),
            worker_handoff: Some(worker_handoff),
        })
    }

    pub fn nonce(&self) -> &str {
        &self.nonce
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// The child acquires worker.lock, then verifies our nonce before opening the DB.
    pub fn handoff_worker(&mut self) {
        self.worker_handoff.take();
    }

    /// Called only after the worker acquired its guard and successfully opened the DB.
    pub fn publish(
        &self,
        listener: &TcpListener,
        token: &str,
        db_path: &Path,
        worker_pid: u32,
        binary_hash: &str,
    ) -> Result<Endpoint, String> {
        let endpoint = Endpoint {
            pid: std::process::id(),
            worker_pid,
            port: listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port(),
            token: token.to_owned(),
            generation: self.nonce.clone(),
            binary_hash: binary_hash.to_owned(),
            protocol: PROTOCOL,
            started_at: now_ms(),
            db_path: fs::canonicalize(db_path)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned(),
        };
        let path = endpoint_path(&self.directory);
        let staging = path.with_extension("json.tmp");
        write_private(
            &staging,
            &serde_json::to_string(&endpoint).map_err(|error| error.to_string())?,
        )?;
        fs::rename(&staging, &path).map_err(|error| format!("publish endpoint: {error}"))?;
        Ok(endpoint)
    }

    pub fn release(&mut self) {
        if self.owner.is_none() {
            return;
        }
        // Keep core.lock held while clearing metadata; a replacement cannot race this.
        let _ = fs::remove_file(endpoint_path(&self.directory));
        let _ = fs::remove_file(self.directory.join(LEASE_FILE));
        self.worker_handoff.take();
        self.owner.take();
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.release();
    }
}

impl WorkerLease {
    pub fn from_environment(db_path: &Path) -> crate::Result<Option<Self>> {
        let directory = std::env::var_os(DATA_DIRECTORY_ENV);
        let generation = std::env::var(GENERATION_ENV).ok();
        match (directory, generation) {
            (None, None) => Ok(None),
            (Some(directory), Some(generation)) => {
                Self::acquire(Path::new(&directory), db_path, &generation)
                    .map(Some)
                    .map_err(Into::into)
            }
            _ => Err("incomplete core worker ownership environment".into()),
        }
    }

    fn acquire(directory: &Path, db_path: &Path, generation: &str) -> Result<Self, String> {
        let guard = lock_worker_after_handoff(directory)?;
        let record: LeaseRecord = serde_json::from_str(
            &fs::read_to_string(directory.join(LEASE_FILE)).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let database = canonical_database_path(db_path).map_err(|error| error.to_string())?;
        if record.nonce != generation || Path::new(&record.db_path) != database {
            return Err("core generation or database changed before worker startup".into());
        }
        Ok(Self {
            _guard: guard,
            generation: generation.to_owned(),
        })
    }

    pub fn ready(&self) -> crate::Result<()> {
        let frame = serde_json::json!({"coreWorkerReady":true,"generation":self.generation,
            "workerPid":std::process::id(),"protocol":PROTOCOL});
        let mut out = std::io::stdout().lock();
        serde_json::to_writer(&mut out, &frame)?;
        out.write_all(b"\n")?;
        out.flush()?;
        Ok(())
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
        let root = std::env::temp_dir().join(format!(
            "mybuddy-core-lease-{}-{}",
            std::process::id(),
            random_token()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("app.db"), []).unwrap();
        Fixture(root)
    }

    #[test]
    fn an_unpublished_live_owner_cannot_be_stolen() {
        let f = fixture();
        let db = f.0.join("app.db");
        let _first = Lease::acquire(&f.0, &db).unwrap();
        assert!(
            Lease::acquire(&f.0, &db)
                .unwrap_err()
                .contains("core already running")
        );
    }

    #[test]
    fn unreachable_endpoint_does_not_override_an_os_lock() {
        let f = fixture();
        let db = f.0.join("app.db");
        let lease = Lease::acquire(&f.0, &db).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        lease
            .publish(&listener, "token", &db, 1, "test-hash")
            .unwrap();
        drop(listener);
        assert!(Lease::acquire(&f.0, &db).is_err());
    }

    #[test]
    fn worker_guard_survives_owner_release_and_blocks_takeover() {
        let f = fixture();
        let db = f.0.join("app.db");
        let mut first = Lease::acquire(&f.0, &db).unwrap();
        first.handoff_worker();
        let worker = WorkerLease::acquire(&f.0, &db, first.nonce()).unwrap();
        drop(first);
        assert!(
            Lease::acquire(&f.0, &db)
                .unwrap_err()
                .contains("worker still running")
        );
        drop(worker);
        assert!(Lease::acquire(&f.0, &db).is_ok());
    }

    #[test]
    fn delayed_worker_cannot_join_a_replacement_generation() {
        let f = fixture();
        let db = f.0.join("app.db");
        let old = Lease::acquire(&f.0, &db).unwrap();
        let nonce = old.nonce().to_owned();
        drop(old);
        let mut new = Lease::acquire(&f.0, &db).unwrap();
        new.handoff_worker();
        assert!(WorkerLease::acquire(&f.0, &db, &nonce).is_err());
        assert!(WorkerLease::acquire(&f.0, &db, new.nonce()).is_ok());
    }

    #[test]
    fn database_initializer_invalidates_a_delayed_child_generation() {
        let f = fixture();
        let db = f.0.join("app.db");
        let mut old = Lease::acquire(&f.0, &db).unwrap();
        let nonce = old.nonce().to_owned();
        // Model parent death before its spawned child acquired the worker guard:
        // kernel handles close, while the published lease record remains on disk.
        old.handoff_worker();
        old.owner.take();
        drop(old);
        assert!(f.0.join(LEASE_FILE).exists());
        let guards = initialization_guards(&f.0).unwrap();
        assert!(!f.0.join(LEASE_FILE).exists());
        fs::write(&db, []).unwrap();
        drop(guards);
        assert!(WorkerLease::acquire(&f.0, &db, &nonce).is_err());
        assert!(Lease::acquire(&f.0, &db).is_ok());
    }

    #[test]
    fn release_keeps_lock_inodes_and_removes_discovery_files() {
        let f = fixture();
        let db = f.0.join("app.db");
        let mut lease = Lease::acquire(&f.0, &db).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        lease
            .publish(&listener, "token", &db, 1, "test-hash")
            .unwrap();
        assert_eq!(read_endpoint(&f.0).unwrap().token, "token");
        lease.release();
        lease.release();
        assert!(!endpoint_path(&f.0).exists());
        assert!(!f.0.join(LEASE_FILE).exists());
        assert!(f.0.join(OWNER_LOCK).exists());
        assert!(f.0.join(WORKER_LOCK).exists());
    }
}
