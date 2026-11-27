use crate::{Result, SqlScope};
use icu_casemap::CaseMapper;
use icu_locale_core::LanguageIdentifier;
use icu_normalizer::ComposingNormalizer;
use icu_properties::{
    CodePointMapData,
    props::{GeneralCategory, GeneralCategoryGroup},
};
use duckdb::{Connection, params_from_iter, types::Value as Param};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

const MAX_MATCHES: usize = 100_000;
const MAX_SCORE_TARGETS: usize = 800;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    scope: SqlScope,
    compact: Vec<u16>,
    terms: Vec<Vec<u16>>,
    fts_query: Option<Vec<u16>>,
    exact_identifier: bool,
}

#[derive(Serialize)]
pub struct Candidates {
    fts: Vec<String>,
    lexical: Vec<Match>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreTarget {
    id: String,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scoring {
    scope: SqlScope,
    compact: Vec<u16>,
    targets: Vec<ScoreTarget>,
}

#[derive(Serialize)]
pub struct TextScore {
    id: String,
    similarity: f64,
}

#[derive(Serialize)]
struct Match {
    id: String,
    content_hash: String,
    importance: f64,
    updated_at: f64,
    exact: u8,
    relevance: usize,
}

fn normalize(raw: &str) -> String {
    if raw.is_ascii() {
        return raw
            .bytes()
            .filter(|byte| {
                !byte.is_ascii_punctuation() && !crate::javascript_whitespace(char::from(*byte))
            })
            .map(|byte| char::from(byte.to_ascii_lowercase()))
            .collect();
    }
    let normalized = ComposingNormalizer::new_nfkc().normalize(raw);
    let lower = CaseMapper::new().lowercase_to_string(&normalized, &LanguageIdentifier::UNKNOWN);
    let categories = CodePointMapData::<GeneralCategory>::new();
    lower
        .chars()
        .filter(|&ch| {
            let category = categories.get(ch);
            !GeneralCategoryGroup::Punctuation.contains(category)
                && !GeneralCategoryGroup::Symbol.contains(category)
                && !crate::javascript_whitespace(ch)
        })
        .collect()
}

#[derive(Default)]
struct NormalizedText {
    entries: HashMap<String, Rc<str>>,
    bytes: usize,
}

impl NormalizedText {
    fn get(&mut self, raw: &str) -> Rc<str> {
        if let Some(text) = self.entries.get(raw) {
            return Rc::clone(text);
        }
        let text: Rc<str> = normalize(raw).into();
        let bytes = raw.len() + text.len();
        if raw.len() <= 32 * 1024 && self.bytes + bytes <= 256 * 1024 {
            self.bytes += bytes;
            self.entries.insert(raw.to_owned(), Rc::clone(&text));
        }
        text
    }
}

fn bigrams(text: &[u16]) -> HashSet<u32> {
    text.windows(2)
        .map(|pair| u32::from(pair[0]) << 16 | u32::from(pair[1]))
        .collect()
}

struct Comparison {
    units: Vec<u16>,
    text: Option<String>,
    grams: HashSet<u32>,
}

impl Comparison {
    fn new(units: Vec<u16>) -> Self {
        let text = String::from_utf16(&units).ok();
        let grams = bigrams(&units);
        Self { units, text, grams }
    }

    fn similarity(&self, text: &str) -> f64 {
        if self.units.is_empty() || text.is_empty() {
            return 0.0;
        }
        if let Some(query) = &self.text {
            if query == text {
                return 1.0;
            }
            if query.contains(text) || text.contains(query.as_str()) {
                return 0.86;
            }
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        if self.text.is_none()
            && (self.units.windows(units.len()).any(|part| part == units)
                || units
                    .windows(self.units.len())
                    .any(|part| part == self.units))
        {
            return 0.86;
        }
        let grams = bigrams(&units);
        let overlap = self.grams.intersection(&grams).count();
        overlap as f64 / (self.grams.len() + grams.len() - overlap).max(1) as f64
    }
}

pub fn score(db: &Connection, request: Scoring) -> Result<Vec<TextScore>> {
    if request.targets.len() > MAX_SCORE_TARGETS {
        return Err("lexical score targets exceed their budget".into());
    }
    if request.targets.is_empty() {
        return Ok(Vec::new());
    }
    let values_clause =
        vec!["(CAST(? AS VARCHAR), CAST(? AS VARCHAR))"; request.targets.len()].join(", ");
    let sql = format!(
        "WITH targets(id, content_hash) AS (VALUES {values_clause})
         SELECT m.id, m.title, m.content
         FROM targets t
         JOIN memory_records m ON m.id = t.id AND m.content_hash = t.content_hash
         WHERE {}",
        request.scope.sql,
    );
    let mut bound: Vec<Param> = Vec::with_capacity(request.targets.len() * 2);
    for target in request.targets {
        bound.push(Param::Text(target.id));
        bound.push(Param::Text(target.content_hash));
    }
    bound.extend(request.scope.parameters());
    let mut statement = db.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(bound))?;
    let comparison = Comparison::new(request.compact);
    let mut normalized = NormalizedText::default();
    let mut scores = Vec::new();
    while let Some(row) = rows.next()? {
        let title = normalized.get(row.get_ref(1)?.as_str()?);
        let content = normalized.get(row.get_ref(2)?.as_str()?);
        let similarity =
            (comparison.similarity(&title) * 1.15).max(comparison.similarity(&content));
        scores.push(TextScore {
            id: row.get(0)?,
            similarity,
        });
    }
    Ok(scores)
}

enum Needle {
    Text(String),
    CodeUnits(Vec<u16>),
}

impl Needle {
    fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => Self::Text(text),
            // JavaScript's two-unit sampling can split an astral code point.
            Err(_) => Self::CodeUnits(units),
        }
    }

    fn matches(&self, title: &str, content: &str, units: Option<&(Vec<u16>, Vec<u16>)>) -> bool {
        match self {
            Self::Text(text) => title.contains(text) || content.contains(text),
            Self::CodeUnits(needle) => units.is_some_and(|(title, content)| {
                title
                    .windows(needle.len())
                    .chain(content.windows(needle.len()))
                    .any(|window| window == needle)
            }),
        }
    }
}

pub fn search(db: &Connection, request: Search) -> Result<Candidates> {
    let where_sql = request.scope.sql.clone();
    let parameters: Vec<Param> = request.scope.parameters().collect();
    let fts = match request.fts_query {
        Some(query) if !query.is_empty() => {
            let raw_query = String::from_utf16_lossy(&query);
            let q_norm = crate::search_postings::normalize_nfkc_lower(&raw_query);
            let q_tokens = crate::search_postings::tokenize_text_with_positions(&q_norm);
            let multi: Vec<String> = q_tokens
                .keys()
                .filter(|k| !k.starts_with("c1:"))
                .cloned()
                .collect();
            let search_tokens: Vec<String> = if multi.is_empty() {
                q_tokens.keys().cloned().collect()
            } else {
                multi
            };
            if search_tokens.is_empty() {
                Vec::new()
            } else {
                let tok_placeholders = vec!["?"; search_tokens.len()].join(",");
                let mut statement = db.prepare(&format!(
                    "SELECT d.entity_id,
                            SUM(p.tf * CASE WHEN p.field = 'title' THEN 3.0 ELSE 1.0 END) AS score
                     FROM search_documents d
                     JOIN search_postings p ON p.doc_key = d.doc_key
                     JOIN memory_records m ON m.id = d.entity_id
                     WHERE d.domain = 'memory'
                       AND p.token_key IN ({tok_placeholders})
                       AND {where_sql}
                     GROUP BY d.entity_id
                     ORDER BY score DESC, d.entity_id ASC",
                ))?;
                let tok_params = search_tokens.into_iter().map(Param::Text);
                let mut rows =
                    statement.query(params_from_iter(tok_params.chain(parameters.clone())))?;
                let mut ids = Vec::new();
                while let Some(row) = rows.next()? {
                    if ids.len() >= MAX_MATCHES {
                        return Err("FTS candidate reply exceeds its budget".into());
                    }
                    ids.push(row.get(0)?);
                }
                ids
            }
        }
        _ => Vec::new(),
    };
    let mut lexical = Vec::new();
    if request.compact.is_empty() || request.terms.is_empty() {
        return Ok(Candidates { fts, lexical });
    }

    let compact = Needle::from_utf16(request.compact);
    let terms: Vec<_> = request
        .terms
        .into_iter()
        .filter(|term| !term.is_empty())
        .map(Needle::from_utf16)
        .collect();
    let needs_code_units = std::iter::once(&compact)
        .chain(&terms)
        .any(|term| matches!(term, Needle::CodeUnits(_)));
    let mut statement = db.prepare(&format!(
        "SELECT m.id,m.title,m.content,m.content_hash,m.importance,m.updated_at
         FROM memory_records m
         WHERE m.id>'' AND {where_sql} ORDER BY m.id",
    ))?;
    let mut rows = statement.query(params_from_iter(&parameters))?;
    let mut normalized = NormalizedText::default();
    while let Some(row) = rows.next()? {
        let title = normalized.get(row.get_ref(1)?.as_str()?);
        let content = normalized.get(row.get_ref(2)?.as_str()?);
        let units = needs_code_units.then(|| {
            (
                title.encode_utf16().collect(),
                content.encode_utf16().collect(),
            )
        });
        let contains = |needle: &Needle| needle.matches(&title, &content, units.as_ref());
        let exact = contains(&compact);
        if request.exact_identifier && !exact {
            continue;
        }
        let relevance = terms.iter().filter(|needle| contains(needle)).count();
        if relevance == 0 {
            continue;
        }
        if lexical.len() >= MAX_MATCHES {
            return Err("lexical candidate reply exceeds its budget".into());
        }
        lexical.push(Match {
            id: row.get(0)?,
            content_hash: row.get(3)?,
            importance: row.get(4)?,
            updated_at: row.get(5)?,
            exact: u8::from(exact),
            relevance,
        });
    }
    Ok(Candidates { fts, lexical })
}
