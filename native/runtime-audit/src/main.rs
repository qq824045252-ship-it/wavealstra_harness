mod artifact_snapshots;
mod cron_data;
mod diagnostics;
mod durable;
mod embedding_index;
mod library_index;
mod library_metadata;
mod library_text;
mod memory_capture;
mod memory_lexical;
mod project_metadata;
mod semantic;
mod semantic_inference;
mod semantic_model;
mod snapshots;
mod sqlite_rows;
mod task_board;
mod task_list;
mod usage;
mod usage_history;
mod usage_live;
mod usage_skills;

use rusqlite::{Connection, OpenFlags, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    error::Error,
    io::{self, BufRead, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

// ECMAScript whitespace, including BOM and excluding the Unicode NEL.
fn javascript_whitespace(ch: char) -> bool {
    matches!(ch,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ScopeParam {
    Text(String),
    Integer(i64),
}

#[derive(Deserialize)]
struct SqlScope {
    sql: String,
    args: Vec<ScopeParam>,
}

impl SqlScope {
    fn parameters(self) -> impl Iterator<Item = SqlValue> {
        self.args.into_iter().map(|value| match value {
            ScopeParam::Text(text) => SqlValue::Text(text),
            ScopeParam::Integer(integer) => SqlValue::Integer(integer),
        })
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Snapshots {
        task_id: String,
        limit: u32,
    },
    CompactSnapshots {
        limit: u32,
    },
    MutateSnapshot {
        epoch: i64,
        write_id: String,
        mutation: snapshots::Mutation,
    },
    Diagnostics {
        task_id: String,
        limit: Option<u32>,
        offset: u64,
        captured_at: f64,
    },
    TaskList {
        dots_task_id: String,
        include_expert_bindings: bool,
    },
    TaskBoard {
        query: task_board::Query,
    },
    ArtifactSnapshots {
        task_ids: Vec<String>,
    },
    LibraryMetadata {
        query: library_metadata::Query,
    },
    ProjectMetadata {
        query: project_metadata::Query,
    },
    CronData {
        query: cron_data::Query,
    },
    WriteDiagnostics {
        epoch: i64,
        sequence: i64,
        writes: Vec<diagnostics::Write>,
    },
    Durable {
        session: String,
        #[serde(flatten)]
        action: durable::Action,
    },
    Semantic {
        #[serde(flatten)]
        request: semantic::Search,
    },
    MemoryLexical {
        #[serde(flatten)]
        request: memory_lexical::Search,
    },
    LibraryText {
        #[serde(flatten)]
        request: library_text::Request,
    },
    PublishLibraryIndex {
        publication: library_index::Publication,
    },
    PublishLibraryDocument {
        publication: library_index::DocumentPublication,
    },
    UsageReport {
        coverage: bool,
        report: usage::Report,
    },
    UsageCsv {
        since: i64,
        coverage: bool,
    },
    UsageHistory {
        job: usage_history::Job,
    },
    CaptureMemory {
        capture: memory_capture::Capture,
    },
    NativeInferenceSupported,
    NativeEmbeddingIndexSupported,
    NativeEmbeddingPlannerSupported,
    NativeModelProbeSupported,
    SemanticModelProbe {
        probe: semantic_model::Probe,
    },
    EmbeddingIndex {
        query: embedding_index::IndexQuery,
    },
    SemanticInference {
        request: semantic_inference::Request,
    },
    StageEmbedding {
        request: embedding_index::StageRequest,
    },
    PublishEmbeddings {
        tokens: Vec<String>,
        at: i64,
    },
    DiscardEmbeddings {
        tokens: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum Data {
    Json(Value),
    Diagnostics(diagnostics::DiagnosticPage),
    TaskList(Vec<task_list::TaskRow>),
    TaskBoard(task_board::Page),
    ArtifactSnapshots(Vec<artifact_snapshots::Snapshot>),
    Semantic(Vec<semantic::Hit>),
    MemoryLexical(memory_lexical::Candidates),
    LibraryText(library_text::Stage),
    LibraryIndex(library_index::Status),
    Embedding(semantic_inference::Embedding),
    StagedEmbedding(embedding_index::StageStatus),
    EmbeddingCounts(embedding_index::Counts),
    EmbeddingIndex(embedding_index::QueryResult),
    ModelInstallation(semantic_model::Installation),
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Reply {
    Ok { data: Data },
    Error,
}

#[derive(Serialize)]
struct WireReply {
    inference: bool,
    #[serde(flatten)]
    reply: Reply,
}

fn write_reply(result: Result<Data>, inference: bool) -> Result<()> {
    let reply = match result {
        Ok(data) => Reply::Ok { data },
        Err(error) => {
            eprintln!("Runtime audit request failed: {error}");
            Reply::Error
        }
    };
    let mut output = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut output, &WireReply { inference, reply })?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

enum InferenceJob {
    Embed(semantic_inference::Request),
    Stage(embedding_index::StageRequest),
    Probe(semantic_model::Probe),
}

fn start_inference(
    db_path: PathBuf,
    staged: Arc<embedding_index::StagedVectors>,
) -> Result<(mpsc::Sender<InferenceJob>, thread::JoinHandle<()>)> {
    let (send, jobs) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("semantic-inference".into())
        .spawn(move || {
            let mut model = semantic_inference::Inference::default();
            let mut verifier = semantic_model::Verifier::default();
            let mut reader = None;
            for request in jobs {
                let result = match request {
                    InferenceJob::Embed(request) => model.run(request).map(Data::Embedding),
                    InferenceJob::Probe(probe) => {
                        Ok(Data::ModelInstallation(verifier.probe(probe)))
                    }
                    InferenceJob::Stage(request) => (|| {
                        if reader.is_none() {
                            reader = Some(read_connection(&db_path)?);
                        }
                        embedding_index::stage(
                            reader.as_ref().unwrap(),
                            &mut model,
                            &staged,
                            request,
                        )
                        .map(Data::StagedEmbedding)
                    })(),
                };
                if result.is_err() {
                    model = semantic_inference::Inference::default();
                }
                if write_reply(result, true).is_err() {
                    break;
                }
            }
        })?;
    Ok((send, worker))
}

fn read(
    db: &mut Connection,
    db_path: &Path,
    durable_sessions: &mut HashMap<String, Connection>,
    writer: &mut Option<Connection>,
    staged: &embedding_index::StagedVectors,
    request: Request,
) -> Result<Data> {
    if matches!(
        request,
        Request::NativeInferenceSupported
            | Request::NativeEmbeddingIndexSupported
            | Request::NativeEmbeddingPlannerSupported
            | Request::NativeModelProbeSupported
    ) {
        return Ok(Data::Json(true.into()));
    }
    if let Request::PublishEmbeddings { tokens, at } = request {
        return staged
            .publish(write_connection(writer, db_path)?, &tokens, at)
            .map(Data::EmbeddingCounts);
    }
    if let Request::DiscardEmbeddings { tokens } = request {
        staged.discard(&tokens)?;
        return Ok(Data::Json(true.into()));
    }
    if let Request::Durable { session, action } = request {
        return durable::read(durable_sessions, session, action).map(Data::Json);
    }
    if let Request::LibraryText { request } = request {
        return library_text::stage(request).map(Data::LibraryText);
    }
    if let Request::PublishLibraryIndex { publication } = request {
        return library_index::publish(write_connection(writer, db_path)?, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::PublishLibraryDocument { publication } = request {
        return library_index::publish_document(write_connection(writer, db_path)?, publication)
            .map(Data::LibraryIndex);
    }
    if let Request::UsageReport { coverage, report } = request {
        return usage::read(db, coverage, report).map(Data::Json);
    }
    if let Request::UsageHistory { job } = request {
        return usage_history::run(writer, db_path, job).map(Data::Json);
    }
    if let Request::CaptureMemory { capture } = request {
        return memory_capture::run(write_connection(writer, db_path)?, capture)
            .map(|saved| Data::Json(saved.into()));
    }
    if let Request::CompactSnapshots { limit } = request {
        return snapshots::compact(db_path, limit).map(|migrated| Data::Json(migrated.into()));
    }
    if let Request::MutateSnapshot {
        epoch,
        write_id,
        mutation,
    } = request
    {
        return snapshots::mutate(db_path, epoch, &write_id, mutation)
            .map(|updated| Data::Json(updated.into()));
    }
    if let Request::WriteDiagnostics {
        epoch,
        sequence,
        writes,
    } = request
    {
        return diagnostics::write_batch(db_path, epoch, sequence, writes)
            .map(|()| Data::Json(true.into()));
    }
    let snapshot = db.transaction()?;
    let response = match request {
        Request::Snapshots { task_id, limit } => {
            Data::Json(snapshots::read(&snapshot, &task_id, limit)?)
        }
        Request::Diagnostics {
            task_id,
            limit,
            offset,
            captured_at,
        } => Data::Diagnostics(diagnostics::read(
            &snapshot,
            &task_id,
            limit,
            offset,
            captured_at,
        )?),
        Request::TaskList {
            dots_task_id,
            include_expert_bindings,
        } => Data::TaskList(task_list::read(
            &snapshot,
            &dots_task_id,
            include_expert_bindings,
        )?),
        Request::ArtifactSnapshots { task_ids } => {
            Data::ArtifactSnapshots(artifact_snapshots::read(&snapshot, &task_ids)?)
        }
        Request::LibraryMetadata { query } => Data::Json(library_metadata::read(&snapshot, query)?),
        Request::ProjectMetadata { query } => Data::Json(project_metadata::read(&snapshot, query)?),
        Request::CronData { query } => Data::Json(cron_data::read(&snapshot, query)?),
        Request::TaskBoard { query } => Data::TaskBoard(task_board::read(&snapshot, query)?),
        Request::Durable { .. } => unreachable!(),
        Request::LibraryText { .. } => unreachable!(),
        Request::PublishLibraryIndex { .. } => unreachable!(),
        Request::PublishLibraryDocument { .. } => unreachable!(),
        Request::UsageReport { .. } => unreachable!(),
        Request::UsageHistory { .. } => unreachable!(),
        Request::CaptureMemory { .. } => unreachable!(),
        Request::NativeInferenceSupported
        | Request::NativeEmbeddingIndexSupported
        | Request::NativeEmbeddingPlannerSupported
        | Request::NativeModelProbeSupported
        | Request::SemanticModelProbe { .. }
        | Request::EmbeddingIndex { .. }
        | Request::SemanticInference { .. }
        | Request::StageEmbedding { .. }
        | Request::PublishEmbeddings { .. }
        | Request::DiscardEmbeddings { .. } => unreachable!(),
        Request::UsageCsv { since, coverage } => {
            Data::Json(usage::export_csv(&snapshot, since, coverage)?.into())
        }
        Request::CompactSnapshots { .. } => unreachable!(),
        Request::MutateSnapshot { .. } => unreachable!(),
        Request::WriteDiagnostics { .. } => unreachable!(),
        Request::Semantic { request } => Data::Semantic(semantic::search(&snapshot, request)?),
        Request::MemoryLexical { request } => {
            Data::MemoryLexical(memory_lexical::search(&snapshot, request)?)
        }
    };
    snapshot.commit()?;
    Ok(response)
}

fn write_connection<'a>(
    connection: &'a mut Option<Connection>,
    path: &Path,
) -> Result<&'a mut Connection> {
    if let Some(db) = connection {
        return Ok(db);
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )?;
    db.busy_timeout(Duration::from_millis(100))?;
    db.pragma_update(None, "foreign_keys", true)?;
    Ok(connection.insert(db))
}

fn read_connection(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(500))?;
    db.pragma_update(None, "query_only", true)?;
    task_board::install_functions(&db)?;
    Ok(db)
}

fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let argument = args.next().ok_or("missing database path")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    if argument == "--protocol-version" {
        println!("25");
        return Ok(());
    }
    let db_path = PathBuf::from(argument);
    let mut db = read_connection(&db_path)?;
    let mut durable_sessions = HashMap::new();
    let mut writer = None;
    let mut inference = None;
    let staged = Arc::new(embedding_index::StagedVectors::default());
    let mut index_queues = embedding_index::IndexQueues::default();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let job = match serde_json::from_str(&line) {
            Ok(Request::SemanticInference { request }) => InferenceJob::Embed(request),
            Ok(Request::StageEmbedding { request }) => InferenceJob::Stage(request),
            Ok(Request::SemanticModelProbe { probe }) => InferenceJob::Probe(probe),
            Ok(Request::EmbeddingIndex { query }) => {
                write_reply(
                    index_queues.query(&mut db, query).map(Data::EmbeddingIndex),
                    false,
                )?;
                continue;
            }
            Ok(request) => {
                write_reply(
                    read(
                        &mut db,
                        &db_path,
                        &mut durable_sessions,
                        &mut writer,
                        &staged,
                        request,
                    ),
                    false,
                )?;
                continue;
            }
            Err(error) => {
                write_reply(Err(error.into()), false)?;
                continue;
            }
        };
        if inference.is_none() {
            inference = Some(start_inference(db_path.clone(), staged.clone())?);
        }
        if inference.as_ref().unwrap().0.send(job).is_err() {
            write_reply(Err("semantic inference thread unavailable".into()), true)?;
        }
    }
    if let Some((sender, worker)) = inference {
        drop(sender);
        worker
            .join()
            .map_err(|_| "semantic inference thread panicked")?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Runtime audit read failed: {error}");
        std::process::exit(1);
    }
}
