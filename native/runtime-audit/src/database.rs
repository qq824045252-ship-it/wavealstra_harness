//! Native DuckDB engine, bounded multi-connection pool, lifecycle locking,
//! safe startup/reset policy, and request-scoped interrupt safety (`DB-01`, `DB-05`, `DB-06`, `CC-06`).

use duckdb::{AccessMode, Config, Connection, InterruptHandle};
use std::collections::VecDeque;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const DUCKDB_FORMAT_VERSION: &str = "mybuddy-duckdb-v1";
pub const DUCKDB_SCHEMA_VERSION: u64 = 8;
pub const CANONICAL_DUCKDB_SCHEMA_SQL: &str = include_str!("duckdb_schema.sql");
const GATEWAY_EXECUTION_SCHEMA_SQL: &str = include_str!("gateway_execution_schema.sql");

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIdentity {
    format: String,
    schema_version: u64,
    database_generation: String,
}

pub fn read_application_identity(db: &Connection) -> duckdb::Result<ApplicationIdentity> {
    db.query_row(
        "SELECT format, schema_version, database_generation FROM database_meta WHERE id=1 AND initialized",
        [],
        |row| Ok(ApplicationIdentity {
            format: row.get(0)?,
            schema_version: row.get(1)?,
            database_generation: row.get(2)?,
        }),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbError {
    Conflict(String),
    Constraint(String),
    Interrupted(String),
    Permission(String),
    Io(String),
    Corrupt(String),
    Busy(String),
    Unavailable(String),
    SchemaMismatch {
        found_format: Option<String>,
        found_version: Option<u64>,
        expected_format: &'static str,
        expected_version: u64,
    },
    Query(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(m) => write!(f, "DuckDB write conflict: {m}"),
            Self::Constraint(m) => write!(f, "DuckDB constraint error: {m}"),
            Self::Interrupted(m) => write!(f, "DuckDB query interrupted: {m}"),
            Self::Permission(m) => write!(f, "DuckDB permission denied: {m}"),
            Self::Io(m) => write!(f, "DuckDB I/O error: {m}"),
            Self::Corrupt(m) => write!(f, "DuckDB corrupt or unreadable database: {m}"),
            Self::Busy(m) => write!(f, "DuckDB database busy/locked: {m}"),
            Self::Unavailable(m) => write!(f, "DuckDB unavailable: {m}"),
            Self::SchemaMismatch {
                found_format,
                found_version,
                expected_format,
                expected_version,
            } => write!(
                f,
                "DuckDB format/schema mismatch (found {:?}/{:?}, expected {}/{})",
                found_format, found_version, expected_format, expected_version
            ),
            Self::Query(m) => write!(f, "DuckDB error: {m}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<duckdb::Error> for DbError {
    fn from(err: duckdb::Error) -> Self {
        classify_duckdb_error(&err.to_string())
    }
}

impl From<std::io::Error> for DbError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            ErrorKind::PermissionDenied => Self::Permission(err.to_string()),
            ErrorKind::WouldBlock => Self::Busy(err.to_string()),
            _ => Self::Io(err.to_string()),
        }
    }
}

pub fn classify_duckdb_error(msg: &str) -> DbError {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("conflict on update")
        || lower.contains("transactioncontext error: conflict")
        || lower.contains("write-write conflict")
    {
        DbError::Conflict(msg.to_owned())
    } else if lower.contains("constraint error")
        || lower.contains("duplicate key")
        || lower.contains("violates primary key")
        || lower.contains("violates unique")
        || lower.contains("violates check")
        || lower.contains("violates not null")
    {
        DbError::Constraint(msg.to_owned())
    } else if lower.contains("interrupt") {
        DbError::Interrupted(msg.to_owned())
    } else if lower.contains("permission denied")
        || lower.contains("access is denied")
        || lower.contains("read-only")
        || lower.contains("readonly")
    {
        DbError::Permission(msg.to_owned())
    } else if lower.contains("could not set lock")
        || lower.contains("conflicting lock")
        || lower.contains("cannot open file") && lower.contains("used by another process")
    {
        DbError::Busy(msg.to_owned())
    } else if lower.contains("not a valid duckdb database file")
        || lower.contains("failure while replaying wal")
        || lower.contains("corrupt")
        || lower.contains("checksum")
        || lower.contains("invalid magic")
    {
        DbError::Corrupt(msg.to_owned())
    } else if lower.contains("io error") {
        DbError::Io(msg.to_owned())
    } else {
        DbError::Query(msg.to_owned())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn next_generation_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ddb-gen-{}-{}-{seq}", std::process::id(), now_ms())
}

#[derive(Clone, Debug)]
pub struct DuckDbPoolConfig {
    pub write_pool_size: usize,
    pub read_pool_size: usize,
    pub duckdb_threads: i64,
    pub max_memory: String,
    pub allow_reset_on_mismatch: bool,
}

impl Default for DuckDbPoolConfig {
    fn default() -> Self {
        let write_pool_size = std::env::var("MYBUDDY_DB_WRITE_WORKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(4)
            .clamp(1, 8);
        let read_pool_size = std::env::var("MYBUDDY_DB_READ_WORKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(4)
            .clamp(1, 8);
        let duckdb_threads = std::env::var("MYBUDDY_DUCKDB_THREADS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(4)
            .clamp(1, 8);
        let max_memory = std::env::var("MYBUDDY_DUCKDB_MAX_MEMORY")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "2GB".to_owned());
        Self {
            write_pool_size,
            read_pool_size,
            duckdb_threads,
            max_memory,
            allow_reset_on_mismatch: false,
        }
    }
}

struct PoolInner {
    conns: VecDeque<(Connection, u64)>,
    next_epoch: u64,
    closed: bool,
}

pub struct BoundedConnPool {
    state: Arc<(Mutex<PoolInner>, Condvar)>,
    capacity: usize,
    is_writer: bool,
}

pub struct PooledConnection {
    pool: Arc<(Mutex<PoolInner>, Condvar)>,
    conn: Option<Connection>,
    epoch: u64,
    is_writer: bool,
    interrupt_handle: Arc<InterruptHandle>,
    bound_request: Option<(String, Arc<crate::request_control::Control>)>,
}

impl PooledConnection {
    pub fn conn(&self) -> &Connection {
        self.conn.as_ref().expect("connection present")
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        self.conn.as_mut().expect("connection present")
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn interrupt_handle(&self) -> Arc<InterruptHandle> {
        Arc::clone(&self.interrupt_handle)
    }

    /// Binds an active request so `Control::cancel(request_id)` interrupts this query ONLY while
    /// it runs on this `(request_id, epoch)`. Automatically unbound before returning to pool (`CC-06`).
    pub fn bind_request(&mut self, request_id: impl Into<String>, control: Arc<crate::request_control::Control>) {
        let req_id = request_id.into();
        let handle = Arc::clone(&self.interrupt_handle);
        control.bind_interrupt(&req_id, self.epoch, Arc::new(move || handle.interrupt()));
        self.bound_request = Some((req_id, control));
    }

    pub fn unbind_request(&mut self) {
        if let Some((req_id, control)) = self.bound_request.take() {
            control.unbind_interrupt(&req_id, self.epoch);
        }
    }
}

impl Drop for PooledConnection {
    fn drop(&mut self) {
        self.unbind_request();
        if let Some(conn) = self.conn.take() {
            if self.is_writer {
                let _ = conn.execute_batch("ROLLBACK");
            }
            let (lock, cv) = &*self.pool;
            let mut inner = lock.lock().unwrap_or_else(|e| e.into_inner());
            inner.conns.push_back((conn, self.epoch));
            cv.notify_one();
        }
    }
}

impl BoundedConnPool {
    fn from_connections(conns: Vec<Connection>, is_writer: bool) -> Self {
        let capacity = conns.len();
        let deque = conns.into_iter().enumerate().map(|(idx, c)| (c, (idx as u64) + 1)).collect();
        Self {
            state: Arc::new((
                Mutex::new(PoolInner {
                    conns: deque,
                    next_epoch: (capacity as u64) + 1,
                    closed: false,
                }),
                Condvar::new(),
            )),
            capacity,
            is_writer,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn checkout(&self, timeout: Duration) -> Result<PooledConnection, DbError> {
        let deadline = std::time::Instant::now() + timeout;
        let (lock, cv) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if guard.closed {
                return Err(DbError::Unavailable("DuckDB connection pool closed".into()));
            }
            if let Some((conn, _)) = guard.conns.pop_front() {
                let epoch = guard.next_epoch;
                guard.next_epoch += 1;
                let interrupt_handle = conn.interrupt_handle();
                return Ok(PooledConnection {
                    pool: Arc::clone(&self.state),
                    conn: Some(conn),
                    epoch,
                    is_writer: self.is_writer,
                    interrupt_handle,
                    bound_request: None,
                });
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(DbError::Busy("Timed out waiting for DuckDB connection".into()));
            }
            let (next_guard, wait_res) = cv
                .wait_timeout(guard, deadline.saturating_duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            guard = next_guard;
            if wait_res.timed_out() && guard.conns.is_empty() {
                return Err(DbError::Busy("Timed out waiting for DuckDB connection".into()));
            }
        }
    }

    fn close(&self) {
        let (lock, cv) = &*self.state;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        guard.closed = true;
        guard.conns.clear();
        cv.notify_all();
    }
}

pub fn duckdb_sidecars(db_path: &Path) -> [PathBuf; 3] {
    let raw = db_path.as_os_str();
    let suffix = |ext: &str| {
        let mut s = raw.to_os_string();
        s.push(ext);
        PathBuf::from(s)
    };
    [suffix(".wal"), suffix(".tmp"), db_path.to_path_buf()]
}

#[derive(Debug, Clone)]
pub struct DuckDbOpenReport {
    pub db_path: PathBuf,
    pub database_generation: String,
    pub schema_version: u64,
    pub rebuilt: bool,
    pub deleted_files: Vec<String>,
}

/// Exclusive owner of one `app.duckdb` database and its bounded independent connections.
pub struct DuckDbEngine {
    db_path: PathBuf,
    database_generation: String,
    config: DuckDbPoolConfig,
    _root_conn: Mutex<Connection>,
    write_pool: BoundedConnPool,
    read_pool: BoundedConnPool,
    reserved_snapshot_reader: Mutex<Connection>,
    reserved_publisher_owner: Mutex<Connection>,
    closed: AtomicBool,
}

impl DuckDbEngine {
    /// Opens an existing current-format DuckDB or initializes a fresh schema.
    ///
    /// Rules (`DB-05`, `DB-06`):
    /// - Confirmed incompatible format/version is deleted ONLY when `config.allow_reset_on_mismatch`
    ///   is true (removing ONLY confirmed DuckDB file + `.wal` + `.tmp` sidecars).
    /// - Existing valid databases keep all data across restarts.
    /// - I/O, permission, busy, and corrupt-file errors fail explicitly without wiping data.
    pub fn open_or_initialize(
        db_path: impl AsRef<Path>,
        config: DuckDbPoolConfig,
    ) -> Result<(Arc<Self>, DuckDbOpenReport), DbError> {
        let path = db_path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }

        let mut rebuilt = false;
        let mut deleted_files = Vec::new();
        let sidecars = duckdb_sidecars(&path);

        if path.exists() {
            // Ensure readable/writable check before opening; permission errors must fail without reset.
            match fs::OpenOptions::new().read(true).open(&path) {
                Ok(_) => {}
                Err(err) => return Err(DbError::from(err)),
            }
            match probe_existing_duckdb_meta(&path) {
                Ok(Some((format, version, _gen)))
                    if format == DUCKDB_FORMAT_VERSION && version == DUCKDB_SCHEMA_VERSION =>
                {
                    // Check write permissions upfront when directory/file is read-only.
                    if fs::metadata(&path)?.permissions().readonly() {
                        return Err(DbError::Permission(format!(
                            "Database file {} is read-only",
                            path.display()
                        )));
                    }
                }
                Ok(Some((format, version, _))) => {
                    if !config.allow_reset_on_mismatch {
                        return Err(DbError::SchemaMismatch {
                            found_format: Some(format),
                            found_version: Some(version),
                            expected_format: DUCKDB_FORMAT_VERSION,
                            expected_version: DUCKDB_SCHEMA_VERSION,
                        });
                    }
                    deleted_files = remove_confirmed_duckdb_files(&sidecars)?;
                    rebuilt = true;
                }
                Ok(None) => {
                    // File exists without initialized `database_meta` (or empty stub): treat as uninitialized ONLY if empty (0 bytes)
                    let meta = fs::metadata(&path)?;
                    if meta.len() == 0 {
                        // DuckDB rejects 0-byte empty files if pre-created; remove empty stub only.
                        fs::remove_file(&path)?;
                    } else if !config.allow_reset_on_mismatch {
                        return Err(DbError::SchemaMismatch {
                            found_format: None,
                            found_version: None,
                            expected_format: DUCKDB_FORMAT_VERSION,
                            expected_version: DUCKDB_SCHEMA_VERSION,
                        });
                    } else {
                        deleted_files = remove_confirmed_duckdb_files(&sidecars)?;
                        rebuilt = true;
                    }
                }
                Err(err) => {
                    // Never auto-delete on IO, permission, busy, or corrupt file!
                    return Err(err);
                }
            }
        } else if sidecars.iter().any(|p| p.exists()) {
            // Orphan WAL/TMP without main db file
            if !config.allow_reset_on_mismatch {
                return Err(DbError::Corrupt(format!(
                    "Orphan DuckDB sidecar exists without main database file {}",
                    path.display()
                )));
            }
            deleted_files = remove_confirmed_duckdb_files(&sidecars)?;
            rebuilt = true;
        }

        let ddb_cfg = Config::default()
            .access_mode(AccessMode::ReadWrite)?
            .threads(config.duckdb_threads)?
            .max_memory(&config.max_memory)?;
        let root_conn = Connection::open_with_flags(&path, ddb_cfg)?;
        let _ = root_conn.execute_batch("SET checkpoint_threshold = '8MB'");

        let db_gen = ensure_schema_and_meta(&root_conn)?;

        let mut writers = Vec::with_capacity(config.write_pool_size);
        for _ in 0..config.write_pool_size {
            writers.push(root_conn.try_clone()?);
        }
        let mut readers = Vec::with_capacity(config.read_pool_size);
        for _ in 0..config.read_pool_size {
            readers.push(root_conn.try_clone()?);
        }
        let reserved_snapshot_reader = root_conn.try_clone()?;
        let reserved_publisher_owner = root_conn.try_clone()?;

        let engine = Arc::new(Self {
            db_path: path.clone(),
            database_generation: db_gen.clone(),
            config,
            _root_conn: Mutex::new(root_conn),
            write_pool: BoundedConnPool::from_connections(writers, true),
            read_pool: BoundedConnPool::from_connections(readers, false),
            reserved_snapshot_reader: Mutex::new(reserved_snapshot_reader),
            reserved_publisher_owner: Mutex::new(reserved_publisher_owner),
            closed: AtomicBool::new(false),
        });
        let report = DuckDbOpenReport {
            db_path: path,
            database_generation: db_gen,
            schema_version: DUCKDB_SCHEMA_VERSION,
            rebuilt,
            deleted_files,
        };
        Ok((engine, report))
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn database_generation(&self) -> &str {
        &self.database_generation
    }

    pub fn config(&self) -> &DuckDbPoolConfig {
        &self.config
    }

    pub fn checkout_writer(&self, timeout: Duration) -> Result<PooledConnection, DbError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DbError::Unavailable("DuckDbEngine closed".into()));
        }
        self.write_pool.checkout(timeout)
    }

    pub fn checkout_reader(&self, timeout: Duration) -> Result<PooledConnection, DbError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(DbError::Unavailable("DuckDbEngine closed".into()));
        }
        self.read_pool.checkout(timeout)
    }

    pub fn reserved_snapshot_reader(&self) -> &Mutex<Connection> {
        &self.reserved_snapshot_reader
    }

    pub fn reserved_publisher_owner(&self) -> &Mutex<Connection> {
        &self.reserved_publisher_owner
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.write_pool.close();
        self.read_pool.close();
        if let Ok(conn) = self._root_conn.lock() {
            let _ = conn.execute_batch("CHECKPOINT");
        }
    }
}

fn remove_confirmed_duckdb_files(targets: &[PathBuf; 3]) -> Result<Vec<String>, DbError> {
    let mut removed = Vec::new();
    for target in targets {
        if !target.exists() {
            continue;
        }
        fs::remove_file(target)?;
        removed.push(target.display().to_string());
    }
    Ok(removed)
}

fn probe_existing_duckdb_meta(db_path: &Path) -> Result<Option<(String, u64, String)>, DbError> {
    let meta = fs::metadata(db_path)?;
    if meta.len() == 0 {
        return Ok(None);
    }
    let cfg = Config::default().access_mode(AccessMode::ReadOnly)?;
    let conn = Connection::open_with_flags(db_path, cfg)?;
    let has_meta: i64 = conn.query_row(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'database_meta'",
        [],
        |r| r.get(0),
    )?;
    if has_meta == 0 {
        return Ok(None);
    }
    let row = conn.query_row(
        "SELECT format, schema_version, database_generation, initialized FROM database_meta WHERE id = 1",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?)),
    );
    match row {
        Ok((format, ver, gen_id, initialized)) => {
            if !initialized {
                Ok(None)
            } else {
                Ok(Some((format, ver.max(0) as u64, gen_id)))
            }
        }
        Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::from(e)),
    }
}

fn ensure_schema_and_meta(conn: &Connection) -> Result<String, DbError> {
    let already_init: Option<(String, i64, String, bool)> = {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'database_meta'",
            [],
            |r| r.get(0),
        )?;
        if exists > 0 {
            match conn.query_row(
                "SELECT format, schema_version, database_generation, initialized FROM database_meta WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            ) {
                Ok(row) => Some(row),
                Err(duckdb::Error::QueryReturnedNoRows) => None,
                Err(e) => return Err(DbError::from(e)),
            }
        } else {
            None
        }
    };

    if let Some((fmt, ver, gen_id, initialized)) = already_init
        && fmt == DUCKDB_FORMAT_VERSION
        && ver as u64 == DUCKDB_SCHEMA_VERSION
        && initialized
    {
        conn.execute_batch(GATEWAY_EXECUTION_SCHEMA_SQL)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_event_coverage (
                entry_id VARCHAR PRIMARY KEY,
                input_known BIGINT NOT NULL,
                output_known BIGINT NOT NULL,
                cache_read_known BIGINT NOT NULL,
                cache_write_known BIGINT NOT NULL,
                cost_known BIGINT NOT NULL
            );",
        )?;
        return Ok(gen_id);
    }

    conn.execute_batch("BEGIN TRANSACTION")?;
    if let Err(err) = conn.execute_batch(CANONICAL_DUCKDB_SCHEMA_SQL)
        .and_then(|_| conn.execute_batch(GATEWAY_EXECUTION_SCHEMA_SQL)) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(DbError::from(err));
    }
    let gen_id = next_generation_token();
    let now = now_ms();
    if let Err(err) = conn.execute(
        "INSERT INTO database_meta (id, format, schema_version, database_generation, initialized, created_at_ms, updated_at_ms)
         VALUES (1, ?, ?, ?, TRUE, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           format = excluded.format,
           schema_version = excluded.schema_version,
           database_generation = excluded.database_generation,
           initialized = TRUE,
           updated_at_ms = excluded.updated_at_ms",
        duckdb::params![DUCKDB_FORMAT_VERSION, DUCKDB_SCHEMA_VERSION as i64, gen_id, now, now],
    ) {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(DbError::from(err));
    }
    conn.execute_batch("COMMIT")?;
    Ok(gen_id)
}

// =========================================================================
// Shared DuckDB porting helpers (`IN-02` / 101-module migration layer)
// =========================================================================

pub fn value_ref_to_json(v: duckdb::types::ValueRef<'_>) -> crate::Result<serde_json::Value> {
    use duckdb::types::ValueRef;
    use serde_json::{Number, Value};
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Boolean(b) => Value::Bool(b),
        ValueRef::TinyInt(n) => Value::from(n as i64),
        ValueRef::SmallInt(n) => Value::from(n as i64),
        ValueRef::Int(n) => Value::from(n as i64),
        ValueRef::BigInt(n) => Value::from(n),
        ValueRef::HugeInt(n) => {
            if let Ok(i) = i64::try_from(n) {
                Value::from(i)
            } else {
                Value::String(n.to_string())
            }
        }
        ValueRef::UTinyInt(n) => Value::from(n as u64),
        ValueRef::USmallInt(n) => Value::from(n as u64),
        ValueRef::UInt(n) => Value::from(n as u64),
        ValueRef::UBigInt(n) => Value::from(n),
        ValueRef::Float(f) => Number::from_f64(f as f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Double(f) => Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Decimal(d) => {
            let s = d.to_string();
            if let Ok(n) = s.parse::<i64>() {
                Value::from(n)
            } else if let Ok(f) = s.parse::<f64>()
                && let Some(num) = Number::from_f64(f)
            {
                Value::Number(num)
            } else {
                Value::String(s)
            }
        }
        ValueRef::Text(bytes) => Value::String(std::str::from_utf8(bytes)?.to_owned()),
        ValueRef::Blob(_) => return Err("unexpected binary column".into()),
        _ => Value::Null,
    })
}

pub fn json_to_sql_value(v: serde_json::Value) -> crate::Result<duckdb::types::Value> {
    use duckdb::types::Value as SqlVal;
    use serde_json::Value;
    Ok(match v {
        Value::Null => SqlVal::Null,
        Value::Bool(b) => SqlVal::Boolean(b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlVal::BigInt(i)
            } else if let Some(u) = n.as_u64() {
                SqlVal::BigInt(i64::try_from(u).map_err(|_| "integer parameter overflow")?)
            } else {
                SqlVal::Double(n.as_f64().ok_or("invalid float JSON parameter")?)
            }
        }
        Value::String(s) => SqlVal::Text(s),
        Value::Array(_) | Value::Object(_) => SqlVal::Text(serde_json::to_string(&v)?),
    })
}

/// Applies SQLite `json_set(raw, '$.path', val, ...)` patches cleanly in Rust without
/// relying on dialect-specific `json_set` SQL functions.
pub fn patch_json_fields(raw: &str, patches: &[(&str, serde_json::Value)]) -> String {
    let mut root = serde_json::from_str::<serde_json::Value>(raw)
        .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
    if !root.is_object() {
        root = serde_json::Value::Object(serde_json::Map::new());
    }
    for (path, val) in patches {
        let trimmed = path.strip_prefix("$.").unwrap_or(path);
        let parts: Vec<&str> = trimmed.split('.').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let mut cur = &mut root;
        for segment in &parts[..parts.len() - 1] {
            if !cur.is_object() {
                *cur = serde_json::Value::Object(serde_json::Map::new());
            }
            let obj = cur.as_object_mut().unwrap();
            if !obj.get(*segment).is_some_and(|v| v.is_object()) {
                obj.insert((*segment).to_owned(), serde_json::Value::Object(serde_json::Map::new()));
            }
            cur = obj.get_mut(*segment).unwrap();
        }
        if let Some(obj) = cur.as_object_mut() {
            obj.insert(parts[parts.len() - 1].to_owned(), val.clone());
        }
    }
    serde_json::to_string(&root).unwrap_or_else(|_| "{}".to_owned())
}

#[repr(C)]
#[derive(Default)]
struct LibcTm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    #[cfg(not(windows))]
    tm_gmtoff: std::ffi::c_long,
    #[cfg(not(windows))]
    tm_zone: *const std::ffi::c_char,
}

#[cfg(windows)]
unsafe extern "C" {
    fn _localtime64_s(tm: *mut LibcTm, time: *const i64) -> i32;
}

#[cfg(not(windows))]
unsafe extern "C" {
    fn localtime_r(time: *const std::ffi::c_long, tm: *mut LibcTm) -> *mut LibcTm;
}

/// Computes the host local `YYYY-MM-DD` date string for a UTC epoch-millisecond timestamp,
/// matching SQLite `date(ms / 1000.0, 'unixepoch', 'localtime')`.
pub fn local_day_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let mut out = LibcTm::default();
    #[cfg(windows)]
    let ok = unsafe { _localtime64_s(&mut out, &secs) == 0 };
    #[cfg(not(windows))]
    let ok = {
        let t = secs as std::ffi::c_long;
        unsafe { !localtime_r(&t, &mut out).is_null() }
    };
    if ok {
        format!(
            "{:04}-{:02}-{:02}",
            out.tm_year + 1900,
            out.tm_mon + 1,
            out.tm_mday
        )
    } else {
        let lp = crate::work_scheduler::local_parts(ms, Some("UTC"));
        format!("{:04}-{:02}-{:02}", lp.year, lp.month, lp.day)
    }
}

pub fn placeholders(count: usize, start_one_based: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start_one_based + i))
        .collect::<Vec<_>>()
        .join(",")
}

pub fn anon_placeholders(count: usize) -> String {
    vec!["?"; count].join(",")
}

pub fn table_exists(conn: &Connection, name: &str) -> crate::Result<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?1",
        duckdb::params![name],
        |r| r.get(0),
    )?;
    Ok(found > 0)
}

pub fn row_bool(row: &duckdb::Row<'_>, idx: usize) -> duckdb::Result<bool> {
    use duckdb::types::ValueRef;
    match row.get_ref(idx)? {
        ValueRef::Boolean(b) => Ok(b),
        ValueRef::TinyInt(n) => Ok(n != 0),
        ValueRef::SmallInt(n) => Ok(n != 0),
        ValueRef::Int(n) => Ok(n != 0),
        ValueRef::BigInt(n) => Ok(n != 0),
        ValueRef::HugeInt(n) => Ok(n != 0),
        _ => row.get::<_, bool>(idx),
    }
}

/// Validates caller-provided SQL is a single read-only SELECT/WITH query without DML/stacked statements.
pub fn ensure_readonly_sql_safe(sql: &str) -> crate::Result<()> {
    let trimmed = sql.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("select ")
        || lower.starts_with("select\n")
        || lower.starts_with("select\t")
        || lower.starts_with("with ")
        || lower.starts_with("with\n"))
    {
        return Err("expected a read-only SELECT query".into());
    }
    let mut in_single = false;
    for c in trimmed.chars() {
        if c == '\'' {
            in_single = !in_single;
        } else if !in_single && c == ';' {
            return Err("stacked statements are not allowed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mybuddy-ddb-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn initializes_full_duckdb_schema_preserves_reopen_and_rejects_corrupt_or_readonly() {
        let dir = temp_dir("init-persist");
        let db_path = dir.join("app.duckdb");
        let (engine, rep1) =
            DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        assert!(!rep1.rebuilt);

        {
            let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
            let tx = w.conn_mut().transaction().unwrap();
            tx.execute(
                "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                 VALUES ('n1', 'g1', 1, 'hello', '{}', 0, 100)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let gen1 = engine.database_generation().to_owned();
        drop(engine);

        // Normal reopen preserves data and database_generation
        let (engine2, rep2) =
            DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        assert!(!rep2.rebuilt);
        assert_eq!(engine2.database_generation(), gen1);
        {
            let r = engine2.checkout_reader(Duration::from_secs(2)).unwrap();
            let title: String = r
                .conn()
                .query_row(
                    "SELECT title FROM core_domain_notes WHERE entity_id = 'n1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(title, "hello");
        }
        drop(engine2);

        // Corrupt bytes file must fail WITHOUT auto-deleting!
        let corrupt_dir = temp_dir("corrupt");
        let corrupt_db = corrupt_dir.join("app.duckdb");
        fs::write(&corrupt_db, b"NOT_A_DUCKDB_FILE_CORRUPT_HEADER").unwrap();
        let corrupt_res =
            DuckDbEngine::open_or_initialize(&corrupt_db, DuckDbPoolConfig { allow_reset_on_mismatch: true, ..Default::default() });
        assert!(corrupt_res.is_err(), "corrupt db must fail closed");
        assert!(corrupt_db.exists(), "corrupt db must NOT be silently deleted");

        // Permission/readonly error must fail WITHOUT deleting!
        let ro_dir = temp_dir("readonly");
        let ro_db = ro_dir.join("app.duckdb");
        let (eng_ro, _) = DuckDbEngine::open_or_initialize(&ro_db, DuckDbPoolConfig::default()).unwrap();
        drop(eng_ro);
        let mut perms = fs::metadata(&ro_db).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&ro_db, perms).unwrap();
        let ro_res = DuckDbEngine::open_or_initialize(
            &ro_db,
            DuckDbPoolConfig { allow_reset_on_mismatch: true, ..Default::default() },
        );
        assert!(matches!(ro_res, Err(DbError::Permission(_))));
        assert!(ro_db.exists());
        let mut perms2 = fs::metadata(&ro_db).unwrap().permissions();
        perms2.set_readonly(false);
        fs::set_permissions(&ro_db, perms2).unwrap();

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&corrupt_dir);
        let _ = fs::remove_dir_all(&ro_dir);
    }

    #[test]
    fn independent_connections_execute_concurrently_without_global_writer_mutex() {
        let dir = temp_dir("concurrent-conns");
        let db_path = dir.join("app.duckdb");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(&db_path, DuckDbPoolConfig::default()).unwrap();
        let barrier = Arc::new(Barrier::new(4));
        let mut handles = Vec::new();
        for i in 0..4 {
            let eng = Arc::clone(&engine);
            let b = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                let mut w = eng.checkout_writer(Duration::from_secs(5)).unwrap();
                let tx = w.conn_mut().transaction().unwrap();
                tx.execute(
                    "INSERT INTO core_domain_notes (entity_id, owner_generation, revision, title, body_json, deleted, updated_at_ms)
                     VALUES (?, 'g1', 1, 'conc', '{}', 0, 100)",
                    duckdb::params![format!("entity-{i}")],
                )
                .unwrap();
                // All 4 open DuckDB write transactions arrive inside DML barrier simultaneously!
                b.wait();
                tx.commit().unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let r = engine.checkout_reader(Duration::from_secs(2)).unwrap();
        let cnt: i64 = r
            .conn()
            .query_row("SELECT COUNT(*) FROM core_domain_notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cnt, 4);
        drop(r);
        drop(engine);
        let _ = fs::remove_dir_all(&dir);
    }
}
