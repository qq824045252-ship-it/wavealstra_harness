use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const FILE_NAME: &str = ".mybuddy-state.json";
const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

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
    revision: Option<String>,
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
}

type StateResult<T> = Result<T, Fault>;

#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    value: Box<RawValue>,
    revision: String,
}

#[derive(Default, Deserialize)]
struct State {
    storage: BTreeMap<Key, Entry>,
    config: BTreeMap<Key, Entry>,
}

/// JSON keys retain JS UTF-16 semantics, including escaped, unpaired code units.
#[derive(Eq, PartialEq, Ord, PartialOrd)]
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

#[derive(PartialEq)]
struct FileStamp {
    modified: Option<SystemTime>,
    bytes: u64,
}

struct CachedState {
    root: PathBuf,
    stamp: Option<FileStamp>,
    state: State,
}

#[derive(Default)]
pub struct Store {
    cache: VecDeque<CachedState>,
}

impl Store {
    pub fn run(&mut self, request: Request) -> Reply {
        self.execute(request)
            .unwrap_or_else(|error| Reply::Error { error })
    }

    fn execute(&mut self, request: Request) -> StateResult<Reply> {
        match request {
            Request::Supported => Ok(Reply::Supported),
            Request::Open { path } => {
                let canonical_path = checked_directory(&path)?;
                self.cache.retain(|entry| entry.root != canonical_path);
                let file = canonical_path.join(FILE_NAME);
                let stamp = checked_file(&file)?;
                let state = read_file(&file, stamp.as_ref())?;
                self.remember(CachedState {
                    root: canonical_path.clone(),
                    stamp,
                    state,
                });
                Ok(Reply::Opened { canonical_path })
            }
            Request::Access {
                path,
                canonical_path,
                bucket,
                action,
            } => {
                ensure_directory(&path, &canonical_path)?;
                let file = canonical_path.join(FILE_NAME);
                let mut stamp = checked_file(&file)?;
                let cached = self
                    .cache
                    .iter()
                    .position(|entry| entry.root == canonical_path)
                    .and_then(|index| self.cache.remove(index));
                let mut state = match cached {
                    Some(entry)
                        if entry.stamp == stamp
                            && stamp.as_ref().is_none_or(|stamp| stamp.modified.is_some()) =>
                    {
                        entry.state
                    }
                    _ => read_file(&file, stamp.as_ref())?,
                };
                let (reply, write_id) = state.apply(bucket, action)?;
                if let Some(write_id) = write_id {
                    write_file(&path, &canonical_path, &file, &write_id, &state)?;
                    stamp = checked_file(&file)?;
                }
                self.remember(CachedState {
                    root: canonical_path,
                    stamp,
                    state,
                });
                Ok(reply)
            }
        }
    }

    fn remember(&mut self, entry: CachedState) {
        self.cache.push_back(entry);
        while self.cache.len() > 8
            || self
                .cache
                .iter()
                .filter_map(|entry| entry.stamp.as_ref())
                .map(|stamp| stamp.bytes)
                .sum::<u64>()
                > MAX_CACHE_BYTES as u64
        {
            self.cache.pop_front();
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
        ensure_directory(data_path, root)?;
        checked_file(file)?;
        fs::rename(&temp, file).map_err(|_| Fault::StorageIo)
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
