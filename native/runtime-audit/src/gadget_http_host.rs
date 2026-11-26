//! Step 7: Shared Rust HTTP Static Gadget Host & Core Gadget Runtime Registry (`RC-17`..`RC-19`).
//!
//! Serves static Gadgets directly out of `mybuddy-runtime-audit` without spawning dedicated
//! Node HTTP host processes (`0` static Node HTTP processes for 0, 1, 10, 20+ open static Gadgets),
//! binds per-instance authorization directly to Core's `request_control::Control` generation, and
//! tracks active backend process registrations without conflating UI disconnects with background owners.

use crate::gadget_state::{self, Action, Authorization, Bucket, Expected, Fault, Reply, Store};
use crate::request_control::Control;
use crate::work_scheduler::now_ms;
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_ACTIVE_HTTP_WORKERS: usize = 64;
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const MAX_LOGS: usize = 100;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    time: i64,
    level: &'static str,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticHostSummary {
    pub gadget_id: String,
    pub name: String,
    pub status: String,
    pub url: String,
    pub port: u16,
    pub generation: String,
    pub started_at: i64,
    pub host_kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRegistration {
    pub gadget_id: String,
    pub generation: String,
    pub pid: u32,
    pub command: Option<String>,
    pub kind: String,
    pub registered_at: i64,
}

struct StaticHostInstance {
    gadget_id: String,
    name: String,
    source_path: PathBuf,
    canonical_source: PathBuf,
    data_path: PathBuf,
    canonical_data: PathBuf,
    entry: String,
    default_config: Map<String, Value>,
    sdk_source: String,
    token: String,
    generation: String,
    url: String,
    port: u16,
    started_at: i64,
    active: Arc<AtomicBool>,
    logs: Arc<Mutex<VecDeque<LogEntry>>>,
    store: Arc<Mutex<Store>>,
    control: Arc<Control>,
    req_seq: Arc<AtomicU64>,
}

#[derive(Default)]
struct SharedHostRegistry {
    static_hosts: HashMap<String, Arc<StaticHostInstance>>,
    backends: HashMap<String, BackendRegistration>,
    active_workers: Arc<AtomicUsize>,
}

fn registry() -> &'static Mutex<SharedHostRegistry> {
    static REGISTRY: OnceLock<Mutex<SharedHostRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(SharedHostRegistry::default()))
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    Supported,
    List,
    Health {
        gadget_id: String,
    },
    StartStatic {
        gadget_id: String,
        name: String,
        source_path: PathBuf,
        data_path: PathBuf,
        entry: String,
        #[serde(default)]
        default_config: Option<Value>,
        sdk_source: String,
        token: String,
        generation: String,
    },
    StopStatic {
        gadget_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    StopAll,
    RevokeGeneration {
        generation: String,
    },
    RegisterBackend {
        gadget_id: String,
        generation: String,
        pid: u32,
        command: Option<String>,
        kind: String,
    },
    UnregisterBackend {
        gadget_id: String,
        generation: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

fn push_log(logs: &Mutex<VecDeque<LogEntry>>, level: &'static str, message: impl Into<String>) {
    if let Ok(mut guard) = logs.lock() {
        guard.push_back(LogEntry {
            time: now_ms(),
            level,
            message: message.into(),
        });
        while guard.len() > MAX_LOGS {
            guard.pop_front();
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_sensitive_segment(segment: &str) -> bool {
    if segment.starts_with('.') {
        return true;
    }
    let lower = segment.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "server"
            | "node_modules"
            | "package.json"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "gadget.json"
            | "auth.json"
            | "oauth.json"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
            | "credentials"
            | "secrets"
    ) {
        return true;
    }
    if lower.starts_with("credentials.")
        || lower.starts_with("credential.")
        || lower.starts_with("secrets.")
        || lower.starts_with("secret.")
    {
        return true;
    }
    matches!(
        Path::new(&lower).extension().and_then(|e| e.to_str()),
        Some("pem" | "key" | "p12" | "pfx")
    )
}

fn safe_source_file(
    source_root: &Path,
    canonical_root: &Path,
    relative: &str,
) -> Option<PathBuf> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains('\0')
        || relative.contains(':')
    {
        return None;
    }
    let mut current = source_root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || is_sensitive_segment(part) {
            return None;
        }
        current = current.join(part);
        let meta = fs::symlink_metadata(&current).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
    }
    let real = fs::canonicalize(&current).ok()?;
    if !real.starts_with(canonical_root) || real == canonical_root {
        return None;
    }
    let info = fs::metadata(&real).ok()?;
    if !info.is_file() {
        return None;
    }
    Some(real)
}

fn mime_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "js" | "mjs" => Some("application/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "wasm" => Some("application/wasm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "txt" => Some("text/plain; charset=utf-8"),
        "csv" => Some("text/csv; charset=utf-8"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

fn decode_url_path(raw: &str) -> Option<String> {
    let mut out = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn inject_sdk_script(html: &str) -> String {
    static HEAD_RE: OnceLock<Regex> = OnceLock::new();
    static DOCTYPE_RE: OnceLock<Regex> = OnceLock::new();
    let head_re = HEAD_RE.get_or_init(|| Regex::new(r"(?i)<head\b[^>]*>").unwrap());
    let doctype_re = DOCTYPE_RE.get_or_init(|| Regex::new(r"(?is)^\s*<!doctype[^>]*>").unwrap());
    let sdk = r#"<script src="/__mybuddy/sdk.js"></script>"#;
    let insert_at = if let Some(m) = head_re.find(html) {
        m.end()
    } else if let Some(m) = doctype_re.find(html) {
        m.end()
    } else {
        0
    };
    let mut out = String::with_capacity(html.len() + sdk.len());
    out.push_str(&html[..insert_at]);
    out.push_str(sdk);
    out.push_str(&html[insert_at..]);
    out
}

fn send_http(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
    send_body: bool,
) {
    let mut header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Cross-Origin-Resource-Policy: same-origin\r\n\
         Referrer-Policy: no-referrer\r\n\
         Vary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        header.push_str(k);
        header.push_str(": ");
        header.push_str(v);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    let _ = stream.write_all(header.as_bytes());
    if send_body && !body.is_empty() {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn send_error_json(stream: &mut TcpStream, status: u16, code: &str, message: &str) {
    let payload = serde_json::to_vec(&json!({ "error": { "code": code, "message": message } }))
        .unwrap_or_else(|_| b"{}".to_vec());
    send_http(
        stream,
        status,
        if status == 404 {
            "Not Found"
        } else if status == 403 {
            "Forbidden"
        } else if status == 401 {
            "Unauthorized"
        } else if status == 409 {
            "Conflict"
        } else if status == 503 {
            "Service Unavailable"
        } else {
            "Error"
        },
        "application/json; charset=utf-8",
        &[],
        &payload,
        true,
    );
}

fn send_value_json(stream: &mut TcpStream, value: Value) {
    let payload = serde_json::to_vec(&json!({ "value": value })).unwrap_or_default();
    if payload.len() > MAX_RESULT_BYTES {
        send_error_json(stream, 413, "RESULT_LIMIT", "后台返回值超过 1 MiB");
        return;
    }
    send_http(
        stream,
        200,
        "OK",
        "application/json; charset=utf-8",
        &[],
        &payload,
        true,
    );
}

fn handle_state_request(
    inst: &StaticHostInstance,
    bucket: Bucket,
    is_config: bool,
    input: &Map<String, Value>,
) -> Result<Value, (u16, &'static str, &'static str)> {
    let op = input
        .get("operation")
        .and_then(Value::as_str)
        .ok_or((400, "UNKNOWN_OPERATION", "未知的数据操作"))?;

    if op == "keys" {
        let reply = {
            let mut store = inst
                .store
                .lock()
                .map_err(|_| (500, "STORAGE_IO", "Gadget 持久数据操作失败"))?;
            store.run_for(
                gadget_state::Request::Access {
                    path: inst.data_path.clone(),
                    canonical_path: inst.canonical_data.clone(),
                    bucket,
                    action: Action::Keys,
                    authorization: None,
                },
                None,
            )
        };
        return match reply {
            Reply::Keys { keys } => {
                let mut set = std::collections::BTreeSet::new();
                for raw in keys {
                    if let Ok(s) = serde_json::from_str::<String>(raw.get()) {
                        set.insert(s);
                    }
                }
                if is_config {
                    for k in inst.default_config.keys() {
                        set.insert(k.clone());
                    }
                }
                Ok(Value::Array(set.into_iter().map(Value::String).collect()))
            }
            Reply::Error { error } => Err(map_fault(&error)),
            _ => Err((500, "STORAGE_UNAVAILABLE", "Gadget 数据服务暂不可用")),
        };
    }

    let key = input
        .get("key")
        .and_then(Value::as_str)
        .ok_or((400, "INVALID_KEY", "缺少数据 key"))?;
    if key.is_empty()
        || key.len() > 240
        || key.bytes().any(|b| b < 0x20)
    {
        return Err((400, "INVALID_KEY", "Gadget 数据 key 无效"));
    }
    let key_units: Vec<u16> = key.encode_utf16().collect();

    let expected = match input.get("expectedRevision") {
        None => None,
        Some(Value::Null) => Some(Expected { revision: None }),
        Some(Value::String(rev)) => Some(Expected {
            revision: Some(rev.clone()),
        }),
        Some(_) => return Err((400, "INVALID_REVISION", "expectedRevision 无效")),
    };

    let seq = inst.req_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let auth = Authorization {
        generation: inst.generation.clone(),
        invocation_id: format!("page-{seq}"),
        expires_at: (now_ms().saturating_add(15_000)) as u64,
    };
    let write_id = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(inst.gadget_id.as_bytes());
        h.update(b":");
        h.update(seq.to_le_bytes());
        h.update(now_ms().to_le_bytes());
        let d = h.finalize();
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]
        )
    };

    let action = match op {
        "get" | "read" => Action::Read { key: key_units },
        "set" => {
            let val = input.get("value").cloned().unwrap_or(Value::Null);
            let value_json = serde_json::to_string(&val)
                .map_err(|_| (400, "INVALID_JSON", "请求和持久数据必须是有效 JSON"))?;
            Action::Set {
                key: key_units,
                value_json,
                expected,
                write_id,
            }
        }
        "delete" => Action::Delete {
            key: key_units,
            expected,
            write_id,
        },
        _ => return Err((400, "UNKNOWN_OPERATION", "未知的数据操作")),
    };

    if !inst.active.load(Ordering::Acquire) {
        return Err((503, "STALE_WRITE", "写入已失效，未提交（Gadget 已停止）"));
    }

    let reply = {
        let mut store = inst
            .store
            .lock()
            .map_err(|_| (500, "STORAGE_IO", "Gadget 持久数据操作失败"))?;
        store.run_for(
            gadget_state::Request::Access {
                path: inst.data_path.clone(),
                canonical_path: inst.canonical_data.clone(),
                bucket,
                action,
                authorization: Some(auth),
            },
            None,
        )
    };

    match reply {
        Reply::Value { entry } => {
            if op == "get" {
                if let Some(entry) = entry {
                    let parsed: Value = serde_json::from_str(entry.value.get())
                        .unwrap_or(Value::Null);
                    Ok(parsed)
                } else if is_config {
                    Ok(inst
                        .default_config
                        .get(key)
                        .cloned()
                        .unwrap_or(Value::Null))
                } else {
                    Ok(Value::Null)
                }
            } else if let Some(entry) = entry {
                let parsed: Value = serde_json::from_str(entry.value.get())
                    .unwrap_or(Value::Null);
                Ok(json!({ "value": parsed, "revision": entry.revision }))
            } else if is_config {
                let fallback = inst
                    .default_config
                    .get(key)
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({ "value": fallback, "revision": Value::Null }))
            } else {
                Ok(json!({ "value": Value::Null, "revision": Value::Null }))
            }
        }
        Reply::Deleted => Ok(Value::Null),
        Reply::Error { error } => Err(map_fault(&error)),
        _ => Err((500, "STORAGE_UNAVAILABLE", "Gadget 数据服务暂不可用")),
    }
}

fn map_fault(fault: &Fault) -> (u16, &'static str, &'static str) {
    match fault {
        Fault::InvalidKey => (400, "INVALID_KEY", "Gadget 数据 key 无效"),
        Fault::InvalidJson => (400, "INVALID_JSON", "请求和持久数据必须是有效 JSON"),
        Fault::RevisionConflict => (409, "REVISION_CONFLICT", "数据已被修改，请重新读取后再保存"),
        Fault::StorageLimit => (413, "STORAGE_LIMIT", "Gadget 持久数据超过容量限制"),
        Fault::StaleWrite => (409, "STALE_WRITE", "写入已失效，未提交（操作已结束或已取消）"),
        Fault::StorageCorrupt => (500, "STORAGE_CORRUPT", "Gadget 持久数据文件已损坏"),
        Fault::StorageUnsafe => (500, "STORAGE_UNSAFE", "Gadget 持久数据路径不安全"),
        Fault::StorageIo => (500, "STORAGE_IO", "Gadget 持久数据读写失败"),
    }
}

fn handle_connection(inst: &StaticHostInstance, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = request_line.trim_end_matches(&['\r', '\n'][..]).split_whitespace();
    let method = match parts.next() {
        Some(m) => m.to_ascii_uppercase(),
        None => {
            send_error_json(&mut stream, 400, "BAD_REQUEST", "Invalid HTTP request");
            return;
        }
    };
    let target = parts.next().unwrap_or("/");
    let raw_path = target.split('?').next().unwrap_or("/");

    let mut headers: HashMap<String, String> = HashMap::new();
    let mut header_bytes = request_line.len();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).unwrap_or(0);
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        header_bytes += n;
        if header_bytes > MAX_HTTP_HEADER_BYTES {
            send_error_json(&mut stream, 431, "HEADER_TOO_LARGE", "Headers too large");
            return;
        }
        if let Some((k, v)) = line.trim_end_matches(&['\r', '\n'][..]).split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }

    if !inst.active.load(Ordering::Acquire) {
        send_error_json(&mut stream, 503, "STOPPING", "Gadget 正在停止");
        return;
    }

    let expected_ip = format!("127.0.0.1:{}", inst.port);
    let expected_localhost = format!("localhost:{}", inst.port);
    let host_hdr = headers.get("host").map(|s| s.to_ascii_lowercase());
    let valid_host = host_hdr
        .as_deref()
        .is_some_and(|h| h == expected_ip || h == expected_localhost);
    if !valid_host {
        send_error_json(&mut stream, 403, "FORBIDDEN", "Forbidden");
        return;
    }
    if let Some(origin) = headers.get("origin") {
        let same_origin = format!("http://{}", host_hdr.as_deref().unwrap_or(""));
        if origin != &same_origin {
            send_error_json(&mut stream, 403, "FORBIDDEN", "Forbidden");
            return;
        }
    }
    if let Some(fetch_site) = headers.get("sec-fetch-site") {
        let nav_get = method == "GET"
            && headers
                .get("sec-fetch-mode")
                .is_some_and(|m| m == "navigate");
        if fetch_site != "same-origin" && fetch_site != "none" && !nav_get {
            send_error_json(&mut stream, 403, "FORBIDDEN", "Forbidden");
            return;
        }
    }

    let route = match decode_url_path(raw_path) {
        Some(r) => r,
        None => {
            send_error_json(&mut stream, 404, "NOT_FOUND", "Not found");
            return;
        }
    };

    if route == "/__mybuddy_health" && method == "GET" {
        send_http(
            &mut stream,
            200,
            "OK",
            "application/json",
            &[],
            br#"{"ok":true}"#,
            true,
        );
        return;
    }

    if route == "/__mybuddy/sdk.js" && method == "GET" {
        send_http(
            &mut stream,
            200,
            "OK",
            "application/javascript; charset=utf-8",
            &[],
            inst.sdk_source.as_bytes(),
            true,
        );
        return;
    }

    if route.starts_with("/__mybuddy/") {
        let supplied = headers
            .get("x-mybuddy-gadget-token")
            .map(String::as_str)
            .unwrap_or("");
        if !constant_time_eq(supplied.as_bytes(), inst.token.as_bytes()) {
            send_error_json(
                &mut stream,
                401,
                "UNAUTHORIZED",
                "Gadget 会话无效，请重新打开页面",
            );
            return;
        }
        if route == "/__mybuddy/runtime" && method == "GET" {
            send_value_json(
                &mut stream,
                json!({
                    "gadgetId": inst.gadget_id,
                    "name": inst.name,
                    "backend": false,
                    "actions": [],
                }),
            );
            return;
        }
        if route == "/__mybuddy/logs" && method == "GET" {
            let entries: Vec<LogEntry> = inst
                .logs
                .lock()
                .map(|g| g.iter().cloned().collect())
                .unwrap_or_default();
            send_value_json(&mut stream, json!(entries));
            return;
        }
        if method != "POST" {
            send_error_json(&mut stream, 405, "METHOD_NOT_ALLOWED", "此接口需要 POST");
            return;
        }
        let ct_ok = headers
            .get("content-type")
            .and_then(|ct| ct.split(';').next())
            .is_some_and(|ct| ct.trim().eq_ignore_ascii_case("application/json"));
        if !ct_ok {
            send_error_json(
                &mut stream,
                415,
                "CONTENT_TYPE",
                "请求必须为 application/json",
            );
            return;
        }
        let len: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if len > MAX_HTTP_BODY_BYTES {
            send_error_json(&mut stream, 413, "BODY_LIMIT", "请求超过 1 MiB");
            return;
        }
        let mut body_buf = vec![0u8; len];
        if len > 0 && reader.read_exact(&mut body_buf).is_err() {
            send_error_json(&mut stream, 400, "INVALID_JSON", "请求不是有效 JSON");
            return;
        }
        let parsed: Value = match serde_json::from_slice(&body_buf) {
            Ok(v) => v,
            Err(_) => {
                send_error_json(&mut stream, 400, "INVALID_JSON", "请求不是有效 JSON");
                return;
            }
        };
        let Some(input) = parsed.as_object() else {
            send_error_json(&mut stream, 400, "INVALID_JSON", "请求必须是 JSON 对象");
            return;
        };

        if route == "/__mybuddy/storage" || route == "/__mybuddy/config" {
            let is_config = route == "/__mybuddy/config";
            let bucket = if is_config {
                Bucket::Config
            } else {
                Bucket::Storage
            };
            match handle_state_request(inst, bucket, is_config, input) {
                Ok(val) => send_value_json(&mut stream, val),
                Err((status, code, msg)) => send_error_json(&mut stream, status, code, msg),
            }
            return;
        }
        send_error_json(&mut stream, 404, "NOT_FOUND", "接口不存在");
        return;
    }

    if method != "GET" && method != "HEAD" {
        send_error_json(
            &mut stream,
            405,
            "METHOD_NOT_ALLOWED",
            "静态资源只支持 GET/HEAD",
        );
        return;
    }

    let relative = if route == "/" {
        inst.entry.as_str()
    } else {
        route.trim_start_matches('/')
    };
    let Some(file_path) = safe_source_file(&inst.source_path, &inst.canonical_source, relative) else {
        send_error_json(&mut stream, 404, "NOT_FOUND", "Not found");
        return;
    };
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let Some(content_type) = mime_type_for_ext(ext) else {
        send_error_json(&mut stream, 404, "NOT_FOUND", "Not found");
        return;
    };

    if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") {
        let Ok(html) = fs::read_to_string(&file_path) else {
            send_error_json(&mut stream, 404, "NOT_FOUND", "Not found");
            return;
        };
        let injected = inject_sdk_script(&html);
        send_http(
            &mut stream,
            200,
            "OK",
            content_type,
            &[(
                "Content-Security-Policy",
                "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
            )],
            injected.as_bytes(),
            method == "GET",
        );
        return;
    }

    let Ok(mut f) = File::open(&file_path) else {
        send_error_json(&mut stream, 404, "NOT_FOUND", "Not found");
        return;
    };
    let mut bytes = Vec::new();
    if method == "HEAD" {
        let len = f.metadata().map(|m| m.len() as usize).unwrap_or(0);
        let dummy = vec![0u8; 0];
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\nVary: Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site\r\n\r\n"
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = dummy;
        let _ = stream.flush();
        return;
    }
    if f.read_to_end(&mut bytes).is_err() {
        send_error_json(&mut stream, 500, "INTERNAL_ERROR", "File read error");
        return;
    }
    send_http(&mut stream, 200, "OK", content_type, &[], &bytes, true);
}

fn wake_listener(port: u16) {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
        let _ = s.shutdown(Shutdown::Both);
    }
}

pub fn handle(
    store: &Arc<Mutex<Store>>,
    control: &Arc<Control>,
    cmd: Command,
) -> crate::Result<Value> {
    match cmd {
        Command::Supported => Ok(json!({
            "supported": true,
            "hostKind": "rust-shared",
        })),
        Command::List => {
            let reg = registry().lock().map_err(|_| "registry lock")?;
            let static_hosts: Vec<StaticHostSummary> = reg
                .static_hosts
                .values()
                .map(|h| StaticHostSummary {
                    gadget_id: h.gadget_id.clone(),
                    name: h.name.clone(),
                    status: if h.active.load(Ordering::Acquire) {
                        "running".into()
                    } else {
                        "stopped".into()
                    },
                    url: h.url.clone(),
                    port: h.port,
                    generation: h.generation.clone(),
                    started_at: h.started_at,
                    host_kind: "rust-shared",
                })
                .collect();
            let backends: Vec<BackendRegistration> = reg.backends.values().cloned().collect();
            Ok(json!({
                "staticHosts": static_hosts,
                "backends": backends,
            }))
        }
        Command::Health { gadget_id } => {
            let reg = registry().lock().map_err(|_| "registry lock")?;
            if let Some(h) = reg.static_hosts.get(&gadget_id) {
                let alive = h.active.load(Ordering::Acquire);
                Ok(json!({
                    "gadgetId": h.gadget_id,
                    "status": if alive { "running" } else { "stopped" },
                    "url": h.url,
                    "port": h.port,
                    "startedAt": h.started_at,
                    "generation": h.generation,
                    "hostKind": "rust-shared",
                }))
            } else {
                Ok(json!({
                    "gadgetId": gadget_id,
                    "status": "stopped",
                    "hostKind": "rust-shared",
                }))
            }
        }
        Command::StartStatic {
            gadget_id,
            name,
            source_path,
            data_path,
            entry,
            default_config,
            sdk_source,
            token,
            generation,
        } => {
            let mut reg = registry().lock().map_err(|_| "registry lock")?;
            if let Some(existing) = reg.static_hosts.get(&gadget_id) {
                if existing.active.load(Ordering::Acquire) && existing.source_path == source_path {
                    return Ok(json!({
                        "gadgetId": existing.gadget_id,
                        "status": "running",
                        "url": existing.url,
                        "port": existing.port,
                        "startedAt": existing.started_at,
                        "generation": existing.generation,
                        "hostKind": "rust-shared",
                    }));
                }
            }

            let canonical_source = fs::canonicalize(&source_path)
                .map_err(|e| format!("Gadget source directory unavailable: {e}"))?;
            let open_reply = {
                let mut st = store.lock().map_err(|_| "store lock")?;
                st.run_for(gadget_state::Request::Open { path: data_path.clone() }, None)
            };
            let canonical_data = match open_reply {
                Reply::Opened { canonical_path } => canonical_path,
                Reply::Error { error } => {
                    let (_, code, msg) = map_fault(&error);
                    return Err(format!("{code}: {msg}").into());
                }
                _ => return Err("Gadget state open failed".into()),
            };

            let _ = safe_source_file(&source_path, &canonical_source, &entry)
                .ok_or_else(|| format!("Gadget entry unavailable: {entry}"))?;

            let default_map = match default_config {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };

            let listener = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| format!("bind shared static host failed: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("local_addr failed: {e}"))?
                .port();
            let url = format!("http://127.0.0.1:{port}/");
            let started_at = now_ms();
            let active = Arc::new(AtomicBool::new(true));
            let logs = Arc::new(Mutex::new(VecDeque::new()));
            push_log(&logs, "info", "Gadget 已启动 (Rust Shared Host)");

            let instance = Arc::new(StaticHostInstance {
                gadget_id: gadget_id.clone(),
                name,
                source_path,
                canonical_source,
                data_path,
                canonical_data,
                entry,
                default_config: default_map,
                sdk_source,
                token,
                generation: generation.clone(),
                url: url.clone(),
                port,
                started_at,
                active: active.clone(),
                logs,
                store: store.clone(),
                control: control.clone(),
                req_seq: Arc::new(AtomicU64::new(0)),
            });

            if let Some(prev) = reg.static_hosts.insert(gadget_id.clone(), instance.clone()) {
                prev.active.store(false, Ordering::Release);
                prev.control.revoke_gadget(prev.generation.clone(), None);
                wake_listener(prev.port);
            }

            let workers = reg.active_workers.clone();
            let worker_inst = instance.clone();
            let worker_port = port;
            thread::Builder::new()
                .name(format!("gadget-http-{port}"))
                .stack_size(128 * 1024)
                .spawn(move || {
                    for incoming in listener.incoming() {
                        if !worker_inst.active.load(Ordering::Acquire) {
                            break;
                        }
                        let Ok(stream) = incoming else {
                            continue;
                        };
                        if !worker_inst.active.load(Ordering::Acquire) {
                            break;
                        }
                        if workers.fetch_add(1, Ordering::AcqRel) >= MAX_ACTIVE_HTTP_WORKERS {
                            workers.fetch_sub(1, Ordering::AcqRel);
                            let mut s = stream;
                            send_error_json(&mut s, 429, "BUSY", "Gadget 服务繁忙，请稍后再试");
                            continue;
                        }
                        let inst_c = worker_inst.clone();
                        let workers_c = workers.clone();
                        let _ = thread::Builder::new()
                            .name(format!("gadget-req-{worker_port}"))
                            .stack_size(256 * 1024)
                            .spawn(move || {
                                handle_connection(&inst_c, stream);
                                workers_c.fetch_sub(1, Ordering::AcqRel);
                            });
                    }
                })
                .map_err(|e| format!("spawn gadget http thread failed: {e}"))?;

            Ok(json!({
                "gadgetId": gadget_id,
                "status": "running",
                "url": url,
                "port": port,
                "startedAt": started_at,
                "generation": generation,
                "hostKind": "rust-shared",
            }))
        }
        Command::StopStatic { gadget_id, reason } => {
            let removed = {
                let mut reg = registry().lock().map_err(|_| "registry lock")?;
                reg.static_hosts.remove(&gadget_id)
            };
            if let Some(prev) = removed {
                prev.active.store(false, Ordering::Release);
                prev.control.revoke_gadget(prev.generation.clone(), None);
                wake_listener(prev.port);
                Ok(json!({
                    "gadgetId": gadget_id,
                    "status": "stopped",
                    "generation": prev.generation,
                    "url": prev.url,
                    "reason": reason.unwrap_or_else(|| "explicit_stop".into()),
                    "exitedAt": now_ms(),
                }))
            } else {
                Ok(json!({
                    "gadgetId": gadget_id,
                    "status": "stopped",
                    "reason": reason.unwrap_or_else(|| "explicit_stop".into()),
                }))
            }
        }
        Command::StopAll => {
            stop_all();
            Ok(json!({ "stopped": true }))
        }
        Command::RevokeGeneration { generation } => {
            let ok = control.revoke_gadget(generation.clone(), None);
            let mut reg = registry().lock().map_err(|_| "registry lock")?;
            let matching_static: Vec<String> = reg
                .static_hosts
                .iter()
                .filter(|(_, inst)| inst.generation == generation)
                .map(|(id, _)| id.clone())
                .collect();
            for id in matching_static {
                if let Some(prev) = reg.static_hosts.remove(&id) {
                    prev.active.store(false, Ordering::Release);
                    wake_listener(prev.port);
                }
            }
            reg.backends.retain(|_, b| b.generation != generation);
            Ok(json!({ "revoked": ok, "generation": generation }))
        }
        Command::RegisterBackend {
            gadget_id,
            generation,
            pid,
            command,
            kind,
        } => {
            let mut reg = registry().lock().map_err(|_| "registry lock")?;
            let entry = BackendRegistration {
                gadget_id: gadget_id.clone(),
                generation,
                pid,
                command,
                kind,
                registered_at: now_ms(),
            };
            reg.backends.insert(gadget_id, entry.clone());
            Ok(json!({ "registered": true, "backend": entry }))
        }
        Command::UnregisterBackend {
            gadget_id,
            generation,
            reason,
        } => {
            control.revoke_gadget(generation.clone(), None);
            let mut reg = registry().lock().map_err(|_| "registry lock")?;
            if let Some(cur) = reg.backends.get(&gadget_id) {
                if cur.generation == generation {
                    reg.backends.remove(&gadget_id);
                }
            }
            Ok(json!({
                "unregistered": true,
                "gadgetId": gadget_id,
                "generation": generation,
                "reason": reason,
            }))
        }
    }
}

pub fn stop_all() {
    let drained: Vec<Arc<StaticHostInstance>> = {
        let Ok(mut reg) = registry().lock() else {
            return;
        };
        reg.backends.clear();
        reg.static_hosts.drain().map(|(_, v)| v).collect()
    };
    for prev in drained {
        prev.active.store(false, Ordering::Release);
        prev.control.revoke_gadget(prev.generation.clone(), None);
        wake_listener(prev.port);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request_control;
    use std::fs;
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn http_get(port: u16, path: &str, headers: &[(&str, &str)]) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        let _ = s.read_to_string(&mut resp);
        let status: u16 = resp
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let body = resp.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
        (status, body)
    }

    fn http_post(
        port: u16,
        path: &str,
        token: &str,
        body_json: &str,
    ) -> (u16, Value) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nX-MyBuddy-Gadget-Token: {token}\r\nContent-Length: {}\r\n\r\n{body_json}",
            body_json.len()
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        let _ = s.read_to_string(&mut resp);
        let status: u16 = resp
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let body = resp.split("\r\n\r\n").nth(1).unwrap_or("{}");
        let parsed = serde_json::from_str(body).unwrap_or(json!({}));
        (status, parsed)
    }

    #[test]
    fn shared_static_host_serves_multiple_gadgets_and_revokes_on_stop() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mybuddy-gadget-host-test-{nonce}"));
        let src = root.join("code");
        let data = root.join("data");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(src.join("index.html"), "<html><head></head><body>ok</body></html>").unwrap();
        fs::write(src.join(".env"), "SECRET=1").unwrap();

        let db_path = root.join("app.db");
        let _ = rusqlite::Connection::open(&db_path).unwrap();
        let control = Control::open(&db_path).unwrap();
        request_control::install(control.clone());
        let store = Arc::new(Mutex::new(Store::default()));

        let gen1 = format!("gen-static-{nonce}");
        let res = handle(
            &store,
            &control,
            Command::StartStatic {
                gadget_id: "g-static-1".into(),
                name: "Static 1".into(),
                source_path: src.clone(),
                data_path: data.clone(),
                entry: "index.html".into(),
                default_config: Some(json!({ "theme": "light" })),
                sdk_source: "window.__sdk=1;".into(),
                token: "tok-1".into(),
                generation: gen1.clone(),
            },
        )
        .unwrap();
        let port = res["port"].as_u64().unwrap() as u16;
        assert_eq!(res["status"], "running");
        assert_eq!(res["hostKind"], "rust-shared");

        let (st_html, html_body) = http_get(port, "/", &[]);
        assert_eq!(st_html, 200);
        assert!(html_body.contains(r#"<script src="/__mybuddy/sdk.js"></script>"#));

        let (st_env, _) = http_get(port, "/.env", &[]);
        assert_eq!(st_env, 404);

        let (st_unauth, _) = http_post(port, "/__mybuddy/storage", "wrong", r#"{"operation":"keys"}"#);
        assert_eq!(st_unauth, 401);

        let (st_cfg, cfg_val) = http_post(
            port,
            "/__mybuddy/config",
            "tok-1",
            r#"{"operation":"get","key":"theme"}"#,
        );
        assert_eq!(st_cfg, 200);
        assert_eq!(cfg_val["value"], "light");

        let (st_set, set_val) = http_post(
            port,
            "/__mybuddy/storage",
            "tok-1",
            r#"{"operation":"set","key":"k","value":42,"expectedRevision":null}"#,
        );
        assert_eq!(st_set, 200);
        assert_eq!(set_val["value"]["value"], 42);

        // Stop revokes generation -> late direct state write under gen1 must fail STALE_WRITE
        let stopped = handle(
            &store,
            &control,
            Command::StopStatic {
                gadget_id: "g-static-1".into(),
                reason: Some("explicit_stop".into()),
            },
        )
        .unwrap();
        assert_eq!(stopped["status"], "stopped");

        let canon_data = fs::canonicalize(&data).unwrap();
        let late_reply = store.lock().unwrap().run_for(
            gadget_state::Request::Access {
                path: data.clone(),
                canonical_path: canon_data,
                bucket: Bucket::Storage,
                action: Action::Set {
                    key: "k".encode_utf16().collect(),
                    value_json: "99".into(),
                    expected: None,
                    write_id: "late-w".into(),
                },
                authorization: Some(Authorization {
                    generation: gen1,
                    invocation_id: "late".into(),
                    expires_at: 0,
                }),
            },
            None,
        );
        assert!(matches!(late_reply, Reply::Error { error: Fault::StaleWrite }));

        let _ = fs::remove_dir_all(&root);
    }
}
