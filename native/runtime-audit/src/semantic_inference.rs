use crate::Result;
use icu_normalizer::ComposingNormalizer;
use ort::{logging::LogLevel, session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::BufReader,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};

static CONFIGURED_INTRA_THREADS: AtomicUsize = AtomicUsize::new(0);
static CONFIGURED_INTER_THREADS: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn configured_threads() -> (usize, usize) {
    let intra = CONFIGURED_INTRA_THREADS.load(Ordering::Acquire);
    let inter = CONFIGURED_INTER_THREADS.load(Ordering::Acquire);
    if intra > 0 && inter > 0 {
        return (intra, inter);
    }
    resolve_thread_bounds()
}

fn resolve_thread_bounds() -> (usize, usize) {
    let intra = std::env::var("MYBUDDY_ORT_INTRA_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(2)
        .clamp(1, 4);
    let inter = std::env::var("MYBUDDY_ORT_INTER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 2);
    CONFIGURED_INTRA_THREADS.store(intra, Ordering::Release);
    CONFIGURED_INTER_THREADS.store(inter, Ordering::Release);
    (intra, inter)
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    library_path: PathBuf,
    model_path: PathBuf,
    tokenizer_path: PathBuf,
    revision: Option<String>,
    pub(crate) dimension: usize,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Text {
    Raw(String),
    NormalizedUtf16(Vec<u16>),
}

#[derive(Deserialize)]
pub struct Request {
    model: Model,
    text: Option<Text>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Embedding {
    load_ms: u64,
    vector: Option<Vec<f32>>,
}

#[derive(Deserialize)]
struct Vocabulary {
    model: VocabularyModel,
    #[serde(default)]
    added_tokens: Vec<AddedToken>,
}

#[derive(Deserialize)]
struct VocabularyModel {
    vocab: Vec<(String, f64)>,
}

#[derive(Deserialize)]
struct AddedToken {
    id: i64,
    content: String,
}

struct Tokenizer {
    pieces: HashMap<Vec<u16>, (i64, f64)>,
    max_len: usize,
}

impl Tokenizer {
    fn load(path: &PathBuf) -> Result<Self> {
        let vocab: Vocabulary = serde_json::from_reader(BufReader::new(File::open(path)?))?;
        let mut pieces = HashMap::with_capacity(vocab.model.vocab.len() + vocab.added_tokens.len());
        let mut max_len = 0;
        for (id, (token, score)) in vocab.model.vocab.into_iter().enumerate() {
            let units: Vec<_> = token.encode_utf16().collect();
            max_len = max_len.max(units.len());
            pieces.insert(units, (id as i64, score));
        }
        for token in vocab.added_tokens {
            let units: Vec<_> = token.content.encode_utf16().collect();
            max_len = max_len.max(units.len());
            pieces.entry(units).or_insert((token.id, 0.0));
        }
        Ok(Self {
            pieces,
            max_len: max_len.min(32),
        })
    }

    fn tokenize(&self, text: Text) -> Vec<i64> {
        const METASPACE: u16 = '▁' as u16;
        const UNKNOWN: &[u16] = &[60, 117, 110, 107, 62];
        let units: Vec<u16> = match text {
            Text::Raw(text) => ComposingNormalizer::new_nfkc()
                .normalize(&text)
                .encode_utf16()
                .collect(),
            Text::NormalizedUtf16(units) => units,
        };
        let input: Vec<u16> = std::iter::once(METASPACE)
            .chain(
                units
                    .into_iter()
                    .map(|unit| if unit == 32 { METASPACE } else { unit }),
            )
            .collect();
        let n = input.len();
        let mut best = vec![f64::NEG_INFINITY; n + 1];
        let mut path = vec![None; n + 1];
        let (unknown_id, unknown_score) = self.pieces.get(UNKNOWN).copied().unwrap_or((3, -10.0));
        best[0] = 0.0;
        for offset in 0..n {
            if best[offset] == f64::NEG_INFINITY {
                continue;
            }
            for next in offset + 1..=(offset + self.max_len).min(n) {
                if let Some(&(id, score)) = self.pieces.get(&input[offset..next]) {
                    let score = best[offset] + score;
                    if score > best[next] {
                        best[next] = score;
                        path[next] = Some((offset, id));
                    }
                }
            }
            if path[offset + 1].is_none() {
                best[offset + 1] = best[offset] + unknown_score - 5.0;
                path[offset + 1] = Some((offset, unknown_id));
            }
        }
        if best[n] == f64::NEG_INFINITY {
            return vec![0, 3, 2];
        }
        let mut ids = vec![2];
        let mut cursor = n;
        while let Some((previous, id)) = path[cursor] {
            ids.push(id);
            cursor = previous;
        }
        ids.push(0);
        ids.reverse();
        ids.truncate(512);
        ids
    }
}

struct LoadedModel {
    model: Model,
    tokenizer: Tokenizer,
    session: Session,
    load_ms: u64,
}

#[derive(Default)]
pub struct Inference {
    loaded: Option<LoadedModel>,
}

impl Inference {
    pub(crate) fn embed_document(&mut self, model: Model, text: String) -> Result<Vec<f32>> {
        self.run(Request {
            model,
            text: Some(Text::Raw(text)),
        })?
        .vector
        .ok_or_else(|| "missing semantic vector".into())
    }

    pub fn run(&mut self, request: Request) -> Result<Embedding> {
        let Request { model, text } = request;
        if self
            .loaded
            .as_ref()
            .is_none_or(|loaded| loaded.model != model)
        {
            self.loaded = None;
            let tokenizer = Tokenizer::load(&model.tokenizer_path)?;
            ort::init_from(&model.library_path)?.commit();
            let (intra_threads, inter_threads) = resolve_thread_bounds();
            let start = Instant::now();
            let session = Session::builder()?
                .with_log_level(LogLevel::Error)?
                .with_intra_threads(intra_threads)?
                .with_inter_threads(inter_threads)?
                .commit_from_file(&model.model_path)?;
            self.loaded = Some(LoadedModel {
                model,
                tokenizer,
                session,
                load_ms: start.elapsed().as_millis() as u64,
            });
        }
        let loaded = self.loaded.as_mut().unwrap();
        let vector = match text {
            Some(text) => Some(loaded.embed(text)?),
            None => None,
        };
        Ok(Embedding {
            load_ms: loaded.load_ms,
            vector,
        })
    }
}

impl LoadedModel {
    fn embed(&mut self, text: Text) -> Result<Vec<f32>> {
        let ids = self.tokenizer.tokenize(text);
        let shape = [1, ids.len()];
        let attention = vec![1_i64; ids.len()];
        let outputs = self.session.run(ort::inputs! {
            "input_ids" => Tensor::from_array((shape, ids))?,
            "attention_mask" => Tensor::from_array((shape, attention))?,
        })?;
        let value = outputs
            .get("sentence_embedding")
            .ok_or("missing sentence_embedding output")?;
        let (_, raw) = value.try_extract_tensor::<f32>()?;
        if raw.len() != self.model.dimension || raw.iter().any(|value| !value.is_finite()) {
            return Err("invalid semantic embedding output".into());
        }
        let norm = raw
            .iter()
            .map(|&value| f64::from(value).powi(2))
            .sum::<f64>()
            .sqrt();
        if norm > 1e-9 {
            Ok(raw
                .iter()
                .map(|&value| (f64::from(value) / norm) as f32)
                .collect())
        } else {
            Ok(raw.to_vec())
        }
    }
}
