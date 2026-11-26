use crate::request_control::Control;
use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

const FILE_NAME: &str = ".mybuddy-state.json";
const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

/// Who authorizes a state change, and until when.
///
/// `expires_at == 0` means the authorization lives as long as its runtime generation
/// (backend/background activity); action and page requests always carry a deadline.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub generation: String,
    pub invocation_id: String,
    pub expires_at: u64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Supported,
    Open {
        path: PathBuf,
    },
    Access {
        path: PathBuf,
        canonical_path: PathBuf,
        bucket: Bucket,
        action: Action,
        #[serde(default)]
        authorization: Option<Authorization>,
    },
    Revoke {
        generation: String,
        #[serde(default)]
        invocation_id: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Bucket {
    Storage,
    Config,
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Read {
        key: Vec<u16>,
    },
    Keys,
    Set {
        key: Vec<u16>,
        value_json: String,
        expected: Option<Expected>,
        write_id: String,
    },
    Delete {
        key: Vec<u16>,
        expected: Option<Expected>,
        write_id: String,
    },
}

#[derive(Deserialize)]
pub struct Expected {
    pub revision: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Supported,
    Opened { canonical_path: PathBuf },
    Value { entry: Option<Entry> },
    Keys { keys: Vec<Box<RawValue>> },
    Deleted,
    Revoked,
    Error { error: Fault },
}

#[derive(Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Fault {
    InvalidKey,
    InvalidJson,
    RevisionConflict,
    StorageCorrupt,
    StorageUnsafe,
    StorageLimit,
    StorageIo,
    /// The writer's lease ended or its invocation/generation was revoked.
    StaleWrite,
}

type StateResult<T> = Result<T, Fault>;

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub value: Box<RawValue>,
    pub revision: String,
}

#[derive(Clone, Default, Deserialize)]
struct State {
    storage: BTreeMap<Key, Entry>,
    config: BTreeMap<Key, Entry>,
}

/// JSON keys retain JS UTF-16 semantics, including escaped, unpaired code units.
#[derive(Clone, Eq, PartialEq, Ord, PartialOrd)]
struct Key(Vec<u16>);

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl<'de> Visitor<'de> for KeyVisitor {
            type Value = Key;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object key")
            }
            fn visit_bytes<E: serde::de::Error>(self, mut bytes: &[u8]) -> Result<Key, E> {
                let mut key = Vec::new();
                loop {
                    let error = match std::str::from_utf8(bytes) {
                        Ok(text) => {
                            key.extend(text.encode_utf16());
                            return Ok(Key(key));
                        }
                        Err(error) => error,
                    };
                    let (valid, suffix) = bytes.split_at(error.valid_up_to());
                    key.extend(
                        std::str::from_utf8(valid)
                            .map_err(E::custom)?
                            .encode_utf16(),
                    );
                    match suffix {
                        [0xed, second @ 0xa0..=0xbf, third @ 0x80..=0xbf, rest @ ..] => {
                            key.push(
                                0xd000
                                    | (u16::from(*second & 0x3f) << 6)
                                    | u16::from(*third & 0x3f),
                            );
                            bytes = rest;
                        }
                        _ => return Err(E::custom("invalid Unicode in Gadget key")),
                    }
                }
            }
        }
        deserializer.deserialize_bytes(KeyVisitor)
    }
}

impl Key {
    fn validate(&self) -> StateResult<()> {
        if self.0.is_empty() || self.0.len() > 240 || self.0.iter().any(|unit| *unit < 0x20) {
            return Err(Fault::InvalidKey);
        }
        Ok(())
    }

    fn quoted(&self) -> StateResult<Box<RawValue>> {
        use std::fmt::Write as _;
        let mut quoted = String::from("\"");
        for decoded in char::decode_utf16(self.0.iter().copied()) {
            match decoded {
                Ok('"') => quoted.push_str("\\\""),
                Ok('\\') => quoted.push_str("\\\\"),
                Ok('\n') => quoted.push_str("\\n"),
                Ok('\r') => quoted.push_str("\\r"),
                Ok('\t') => quoted.push_str("\\t"),
                Ok('\u{8}') => quoted.push_str("\\b"),
                Ok('\u{c}') => quoted.push_str("\\f"),
                Ok(ch) if ch < '\u{20}' => {
                    let _ = write!(quoted, "\\u{:04x}", ch as u32);
                }
                Ok(ch) => quoted.push(ch),
                Err(error) => {
                    let _ = write!(quoted, "\\u{:04x}", error.unpaired_surrogate());
                }
            }
        }
        quoted.push('"');
        RawValue::from_string(quoted).map_err(|_| Fault::StorageCorrupt)
    }
}

#[derive(Clone, PartialEq)]
struct FileStamp {
    modified: Option<SystemTime>,
    bytes: u64,
}

#[derive(Default)]
struct RootState {
    populated: bool,
    stamp: Option<FileStamp>,
    state: State,
    last_used: u64,
}

pub struct Store {
    roots: Mutex<HashMap<PathBuf, Arc<Mutex<RootState>>>>,
    use_seq: AtomicU64,
    control: Arc<Control>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            roots: Mutex::new(HashMap::new()),
            use_seq: AtomicU64::new(1),
            control: crate::request_control::shared()
                .cloned()
                .unwrap_or_else(Control::memory),
        }
    }
}

#[cfg(test)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl Store {
    #[cfg(test)]
    pub fn with_control(control: Arc<Control>) -> Self {
        Self {
            roots: Mutex::new(HashMap::new()),
            use_seq: AtomicU64::new(1),
            control,
        }
    }

    #[cfg(test)]
    pub fn run(&self, request: Request) -> Reply {
        self.run_for(request, None)
    }

    pub fn run_for(&self, request: Request, request_id: Option<&str>) -> Reply {
        self.execute(request, request_id)
            .unwrap_or_else(|error| Reply::Error { error })
    }

    fn root_lock(&self, canonical_path: &Path) -> Arc<Mutex<RootState>> {
        let mut map = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            map.entry(canonical_path.to_path_buf())
                .or_insert_with(|| Arc::new(Mutex::new(RootState::default()))),
        )
    }

    fn write_allowed(
        &self,
        authorization: Option<&Authorization>,
        request_id: Option<&str>,
    ) -> StateResult<()> {
        let authorization = authorization.ok_or(Fault::StaleWrite)?;
        if !self.control.gadget_check(
            request_id,
            &authorization.generation,
            &authorization.invocation_id,
            authorization.expires_at,
        ) {
            return Err(Fault::StaleWrite);
        }
        Ok(())
    }

    fn revoke(&self, generation: String, invocation_id: Option<String>) -> StateResult<Reply> {
        if self.control.revoke_gadget(generation, invocation_id) {
            Ok(Reply::Revoked)
        } else {
            Err(Fault::StaleWrite)
        }
    }

    fn execute(&self, request: Request, request_id: Option<&str>) -> StateResult<Reply> {
        match request {
            Request::Supported => Ok(Reply::Supported),
            Request::Revoke {
                generation,
                invocation_id,
            } => self.revoke(generation, invocation_id),
            Request::Open { path } => {
                let canonical_path = checked_directory(&path)?;
                let lock = self.root_lock(&canonical_path);
                {
                    let mut root = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let file = canonical_path.join(FILE_NAME);
                    let stamp = checked_file(&file)?;
                    let state = read_file(&file, stamp.as_ref())?;
                    root.populated = true;
                    root.stamp = stamp;
                    root.state = state;
                    root.last_used = self.use_seq.fetch_add(1, Ordering::Relaxed);
                }
                self.trim_cache(&canonical_path);
                Ok(Reply::Opened { canonical_path })
            }
            Request::Access {
                path,
                canonical_path,
                bucket,
                action,
                authorization,
            } => {
                // A write is authorized at commit time, not when the host asked.
                // Reads stay available so a cancelled action cannot wedge the page.
                if matches!(action, Action::Set { .. } | Action::Delete { .. }) {
                    self.write_allowed(authorization.as_ref(), request_id)?;
                }
                ensure_directory(&path, &canonical_path)?;
                let lock = self.root_lock(&canonical_path);
                let reply = {
                    let mut root = lock.lock().unwrap_or_else(|e| e.into_inner());
                    let file = canonical_path.join(FILE_NAME);
                    let mut stamp = checked_file(&file)?;
                    let mut state = if root.populated
                        && root.stamp == stamp
                        && stamp.as_ref().is_none_or(|stamp| stamp.modified.is_some())
                    {
                        root.state.clone()
                    } else {
                        read_file(&file, stamp.as_ref())?
                    };
                    let (reply, write_id) = state.apply(bucket, action)?;
                    if let Some(write_id) = write_id {
                        let authorization = authorization.as_ref().ok_or(Fault::StaleWrite)?;
                        write_file(
                            &path,
                            &canonical_path,
                            &file,
                            &write_id,
                            &state,
                            |temp, destination| {
                                self.control
                                    .gadget_commit(
                                        request_id,
                                        &authorization.generation,
                                        &authorization.invocation_id,
                                        authorization.expires_at,
                                        || fs::rename(temp, destination).map_err(|_| Fault::StorageIo),
                                    )
                                    .ok_or(Fault::StaleWrite)?
                            },
                        )?;
                        stamp = checked_file(&file)?;
                    }
                    root.populated = true;
                    root.stamp = stamp;
                    root.state = state;
                    root.last_used = self.use_seq.fetch_add(1, Ordering::Relaxed);
                    reply
                };
                self.trim_cache(&canonical_path);
                Ok(reply)
            }
        }
    }

    fn trim_cache(&self, keep: &Path) {
        let entries: Vec<(PathBuf, Arc<Mutex<RootState>>)> = {
            let map = self.roots.lock().unwrap_or_else(|e| e.into_inner());
            if map.len() <= 8 {
                return;
            }
            map.iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect()
        };
        let mut cached: Vec<(PathBuf, u64, u64)> = Vec::new();
        for (path, lock) in entries {
            // Never block waiting on an unrelated gadget performing slow fsync.
            if let Ok(guard) = lock.try_lock()
                && guard.populated
            {
                let bytes = guard.stamp.as_ref().map_or(0, |s| s.bytes);
                cached.push((path, guard.last_used, bytes));
            }
        }
        cached.sort_by_key(|entry| entry.1);
        let mut total_bytes: u64 = cached.iter().map(|entry| entry.2).sum();
        let mut count = cached.len();
        let mut evict = Vec::new();
        for (path, _, bytes) in cached {
            if count <= 8 && total_bytes <= MAX_CACHE_BYTES as u64 {
                break;
            }
            if path == keep {
                continue;
            }
            count = count.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(bytes);
            evict.push(path);
        }
        if !evict.is_empty()
            && let Ok(mut map) = self.roots.try_lock()
        {
            for path in evict {
                map.remove(&path);
            }
        }
    }
}

impl State {
    fn apply(&mut self, bucket: Bucket, action: Action) -> StateResult<(Reply, Option<String>)> {
        let entries = match bucket {
            Bucket::Storage => &mut self.storage,
            Bucket::Config => &mut self.config,
        };
        match action {
            Action::Keys => Ok((
                Reply::Keys {
                    keys: entries
                        .keys()
                        .map(Key::quoted)
                        .collect::<StateResult<_>>()?,
                },
                None,
            )),
            Action::Read { key } => {
                let key = Key(key);
                key.validate()?;
                Ok((
                    Reply::Value {
                        entry: entries.get(&key).cloned(),
                    },
                    None,
                ))
            }
            Action::Set {
                key,
                value_json,
                expected,
                write_id,
            } => {
                let key = Key(key);
                key.validate()?;
                check_revision(entries.get(&key), expected)?;
                if value_json.len() > MAX_BYTES {
                    return Err(Fault::StorageLimit);
                }
                let value = prepare_value(
                    RawValue::from_string(value_json).map_err(|_| Fault::InvalidJson)?,
                )?;
                let entry = Entry {
                    value,
                    revision: write_id.clone(),
                };
                entries.insert(key, entry.clone());
                Ok((Reply::Value { entry: Some(entry) }, Some(write_id)))
            }
            Action::Delete {
                key,
                expected,
                write_id,
            } => {
                let key = Key(key);
                key.validate()?;
                check_revision(entries.get(&key), expected)?;
                entries.remove(&key);
                Ok((Reply::Deleted, Some(write_id)))
            }
        }
    }
}

fn check_revision(entry: Option<&Entry>, expected: Option<Expected>) -> StateResult<()> {
    if let Some(expected) = expected
        && expected.revision.as_deref() != entry.map(|entry| entry.revision.as_str())
    {
        return Err(Fault::RevisionConflict);
    }
    Ok(())
}

fn checked_directory(path: &Path) -> StateResult<PathBuf> {
    let info = fs::symlink_metadata(path).map_err(|_| Fault::StorageUnsafe)?;
    if !info.is_dir() || is_link(&info) {
        return Err(Fault::StorageUnsafe);
    }
    path.canonicalize().map_err(|_| Fault::StorageUnsafe)
}

fn ensure_directory(path: &Path, canonical_path: &Path) -> StateResult<()> {
    if checked_directory(path)? != canonical_path {
        return Err(Fault::StorageUnsafe);
    }
    Ok(())
}

fn is_link(info: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes directory junctions and other Windows reparse points.
        info.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        info.file_type().is_symlink()
    }
}

fn checked_file(path: &Path) -> StateResult<Option<FileStamp>> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Fault::StorageIo),
    };
    if !info.is_file() || is_link(&info) {
        return Err(Fault::StorageUnsafe);
    }
    if info.len() > MAX_BYTES as u64 {
        return Err(Fault::StorageLimit);
    }
    Ok(Some(FileStamp {
        bytes: info.len(),
        modified: info.modified().ok(),
    }))
}

fn read_file(path: &Path, stamp: Option<&FileStamp>) -> StateResult<State> {
    let Some(stamp) = stamp else {
        return Ok(State::default());
    };
    let mut content = Vec::with_capacity(stamp.bytes as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_BYTES as u64 + 1).read_to_end(&mut content))
        .map_err(|_| Fault::StorageIo)?;
    if content.len() > MAX_BYTES {
        return Err(Fault::StorageLimit);
    }
    let raw: State = serde_json::from_slice(&content).map_err(|_| Fault::StorageCorrupt)?;
    let normalize = |entries: BTreeMap<Key, Entry>| {
        entries
            .into_iter()
            .map(|(key, entry)| {
                Ok((
                    key,
                    Entry {
                        value: prepare_value(entry.value)?,
                        revision: entry.revision,
                    },
                ))
            })
            .collect::<StateResult<_>>()
    };
    let state = State {
        storage: normalize(raw.storage)?,
        config: normalize(raw.config)?,
    };
    Ok(state)
}

fn prepare_value(value: Box<RawValue>) -> StateResult<Box<RawValue>> {
    validate_value(&value)?;
    // Raw JSON strings cannot contain literal line breaks. Only formatting whitespace is removed.
    if value.get().contains(['\n', '\r']) {
        let compact = value.get().replace(['\n', '\r'], "");
        return RawValue::from_string(compact).map_err(|_| Fault::StorageCorrupt);
    }
    Ok(value)
}

fn validate_value(value: &RawValue) -> StateResult<()> {
    let mut chars = value.get().char_indices().peekable();
    let mut depth = 0;
    while let Some((start, ch)) = chars.next() {
        match ch {
            ']' | '}' => depth -= 1,
            ',' | ':' | ' ' | '\n' | '\r' | '\t' => (),
            _ if depth > 64 => return Err(Fault::InvalidJson),
            '[' | '{' => depth += 1,
            '"' => {
                while let Some((_, ch)) = chars.next() {
                    if ch == '"' {
                        break;
                    }
                    if ch == '\\' {
                        chars.next();
                    }
                }
            }
            '0'..='9' | '-' => {
                while chars
                    .next_if(|&(_, ch)| matches!(ch, '0'..='9' | '-' | '+' | '.' | 'e' | 'E'))
                    .is_some()
                {}
                let end = chars.peek().map_or(value.get().len(), |&(end, _)| end);
                if !value.get()[start..end]
                    .parse::<f64>()
                    .is_ok_and(f64::is_finite)
                {
                    return Err(Fault::InvalidJson);
                }
            }
            _ => (),
        }
    }
    Ok(())
}

fn write_file(
    data_path: &Path,
    root: &Path,
    file: &Path,
    write_id: &str,
    state: &State,
    commit: impl FnOnce(&Path, &Path) -> StateResult<()>,
) -> StateResult<()> {
    if write_id.len() != 36
        || !write_id
            .bytes()
            .all(|ch| ch.is_ascii_hexdigit() || ch == b'-')
    {
        return Err(Fault::StorageIo);
    }
    if state.storage.len() + state.config.len() > MAX_ENTRIES {
        return Err(Fault::StorageLimit);
    }
    let mut content = Vec::new();
    content.extend_from_slice(b"{\"storage\":");
    encode_bucket(&mut content, &state.storage)?;
    content.extend_from_slice(b",\"config\":");
    encode_bucket(&mut content, &state.config)?;
    content.push(b'}');
    if content.len() > MAX_BYTES {
        return Err(Fault::StorageLimit);
    }

    let temp = root.join(format!("{FILE_NAME}.{write_id}.tmp"));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut staged = options.open(&temp).map_err(|_| Fault::StorageIo)?;
    let result = (|| {
        staged.write_all(&content).map_err(|_| Fault::StorageIo)?;
        staged.sync_all().map_err(|_| Fault::StorageIo)?;
        drop(staged);
        if let Ok(spec) = std::env::var("MYBUDDY_TEST_GADGET_FSYNC_DELAY_MATCH")
            && let Some((pattern, ms_str)) = spec.split_once(':')
            && !pattern.is_empty()
            && let Ok(ms) = ms_str.parse::<u64>()
            && root.to_string_lossy().contains(pattern)
        {
            std::thread::sleep(Duration::from_millis(ms.min(2_000)));
        }
        ensure_directory(data_path, root)?;
        checked_file(file)?;
        commit(&temp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn encode_bucket(content: &mut Vec<u8>, entries: &BTreeMap<Key, Entry>) -> StateResult<()> {
    content.push(b'{');
    for (index, (key, entry)) in entries.iter().enumerate() {
        if index != 0 {
            content.push(b',');
        }
        content.extend_from_slice(key.quoted()?.get().as_bytes());
        content.push(b':');
        serde_json::to_writer(&mut *content, entry).map_err(|_| Fault::StorageIo)?;
        if content.len() > MAX_BYTES {
            return Err(Fault::StorageLimit);
        }
    }
    content.push(b'}');
    Ok(())
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
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mybuddy-gadget-state-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root)
            .unwrap_or_else(|error| panic!("create {}: {error}", root.display()));
        Fixture(root)
    }

    /// The host opens the data directory first and only ever sends its canonical form.
    fn opened(root: &Path) -> (Store, PathBuf) {
        let store = Store::default();
        match store.run(Request::Open {
            path: root.to_path_buf(),
        }) {
            Reply::Opened { canonical_path } => (store, canonical_path),
            reply => panic!(
                "open must succeed: {}",
                serde_json::to_string(&reply).expect("json")
            ),
        }
    }

    fn authorization(generation: &str, invocation_id: &str, expires_at: u64) -> Authorization {
        Authorization {
            generation: generation.to_owned(),
            invocation_id: invocation_id.to_owned(),
            expires_at,
        }
    }

    fn write(
        store: &Store,
        root: &Path,
        canonical: &Path,
        authorization: Option<Authorization>,
    ) -> Reply {
        store.run(Request::Access {
            path: root.to_path_buf(),
            canonical_path: canonical.to_path_buf(),
            bucket: Bucket::Storage,
            action: Action::Set {
                key: vec![u16::from(b'k')],
                value_json: "{\"value\":1}".to_owned(),
                expected: None,
                write_id: "00000000-0000-0000-0000-000000000000".to_owned(),
            },
            authorization,
        })
    }

    fn is_stale(reply: &Reply) -> bool {
        matches!(
            reply,
            Reply::Error {
                error: Fault::StaleWrite,
            }
        )
    }

    #[test]
    fn a_write_needs_a_live_authorization() {
        let fixture = fixture();
        let (store, canonical) = opened(&fixture.0);
        let file = canonical.join(FILE_NAME);
        assert!(is_stale(&write(&store, &fixture.0, &canonical, None)));
        let expired = authorization("g", "i", now_ms().saturating_sub(1));
        assert!(is_stale(&write(
            &store,
            &fixture.0,
            &canonical,
            Some(expired)
        )));
        assert!(!file.exists(), "a rejected write must not touch the file");
        let live = authorization("g", "i", now_ms() + 60_000);
        assert!(matches!(
            write(&store, &fixture.0, &canonical, Some(live)),
            Reply::Value { .. }
        ));
        assert!(file.exists());
    }

    #[test]
    fn revoked_invocations_and_generations_cannot_write() {
        let fixture = fixture();
        let (store, canonical) = opened(&fixture.0);
        let generation = "generation-1";
        assert!(matches!(
            store.run(Request::Revoke {
                generation: generation.to_owned(),
                invocation_id: Some("invocation-1".to_owned()),
            }),
            Reply::Revoked
        ));
        // A cancelled action cannot commit, but its sibling and the backend still can.
        let retired = authorization(generation, "invocation-1", 0);
        assert!(is_stale(&write(
            &store,
            &fixture.0,
            &canonical,
            Some(retired)
        )));
        let sibling = authorization(generation, "invocation-2", 0);
        assert!(matches!(
            write(&store, &fixture.0, &canonical, Some(sibling)),
            Reply::Value { .. }
        ));
        assert!(matches!(
            store.run(Request::Revoke {
                generation: generation.to_owned(),
                invocation_id: None,
            }),
            Reply::Revoked
        ));
        let background = authorization(generation, "runtime", 0);
        assert!(is_stale(&write(
            &store,
            &fixture.0,
            &canonical,
            Some(background)
        )));
        // Reads stay available: revoking a writer must not wedge the page.
        let read = store.run(Request::Access {
            path: fixture.0.clone(),
            canonical_path: canonical.clone(),
            bucket: Bucket::Storage,
            action: Action::Read {
                key: vec![u16::from(b'k')],
            },
            authorization: None,
        });
        assert!(matches!(read, Reply::Value { .. }));
    }
    #[test]
    fn revocation_during_staging_prevents_the_final_rename() {
        let fixture = fixture();
        let control = Control::memory();
        let root = fixture.0.canonicalize().unwrap();
        let destination = root.join(FILE_NAME);
        let result = write_file(
            &fixture.0,
            &root,
            &destination,
            "00000000-0000-0000-0000-000000000001",
            &State::default(),
            |temporary, final_path| {
                // This hook runs AFTER serialization, temporary write and sync_all.
                assert!(temporary.exists());
                control.revoke_gadget("generation".into(), Some("invocation".into()));
                control
                    .gadget_commit(None, "generation", "invocation", 0, || {
                        fs::rename(temporary, final_path).map_err(|_| Fault::StorageIo)
                    })
                    .ok_or(Fault::StaleWrite)?
            },
        );
        assert!(matches!(result, Err(Fault::StaleWrite)));
        assert!(!destination.exists());
        assert_eq!(
            fs::read_dir(root).unwrap().count(),
            0,
            "rejected staging file is cleaned"
        );
    }

    #[test]
    fn cancellation_while_staging_is_checked_at_the_commit_boundary() {
        let fixture = fixture();
        let root = fixture.0.canonicalize().unwrap();
        let destination = root.join(FILE_NAME);
        let control = Control::memory();
        control
            .register("write", "gadgetState", now_ms() + 30_000, true)
            .unwrap_or_else(|_| panic!("admit"));
        control.start("write").unwrap_or_else(|_| panic!("start"));
        let result = write_file(
            &fixture.0,
            &root,
            &destination,
            "00000000-0000-0000-0000-000000000001",
            &State::default(),
            |temporary, final_path| {
                control.cancel("write");
                control
                    .gadget_commit(Some("write"), "g", "i", 0, || {
                        fs::rename(temporary, final_path).map_err(|_| Fault::StorageIo)
                    })
                    .ok_or(Fault::StaleWrite)?
            },
        );
        assert!(matches!(result, Err(Fault::StaleWrite)));
        assert!(!destination.exists());
    }

    #[test]
    fn two_distinct_gadget_roots_make_concurrent_write_progress() {
        let fix = fixture();
        let dir_a = fix.0.join("gadget-a");
        let dir_b = fix.0.join("gadget-b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        let store = Arc::new(Store::default());
        let can_a = match store.run(Request::Open { path: dir_a.clone() }) {
            Reply::Opened { canonical_path } => canonical_path,
            _ => panic!("open a"),
        };
        let can_b = match store.run(Request::Open { path: dir_b.clone() }) {
            Reply::Opened { canonical_path } => canonical_path,
            _ => panic!("open b"),
        };

        // Hold lock on root A while thread B writes root B; B must finish without blocking on A.
        let lock_a = store.root_lock(&can_a);
        let guard_a = lock_a.lock().unwrap();
        let store_b = Arc::clone(&store);
        let dir_b_c = dir_b.clone();
        let can_b_c = can_b.clone();
        let handle = std::thread::spawn(move || {
            let auth = authorization("g-conc", "inv-b", now_ms() + 30_000);
            write(&store_b, &dir_b_c, &can_b_c, Some(auth))
        });
        let reply_b = handle.join().unwrap();
        drop(guard_a);
        assert!(matches!(reply_b, Reply::Value { .. }));
        assert!(can_b.join(FILE_NAME).exists());
    }
}
