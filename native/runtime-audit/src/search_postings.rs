//! Rust-side NFKC/CJK/model-identifier tokenization & DuckDB `search_documents` /
//! `search_postings` inverted index (`IN-06`).
//!
//! Preserves CJK 1–2 character queries, NFKC/case-folding, model-code/identifier tokens
//! (`DS3806`, `MFM6400`, `gpt-4o`, hyphen/underscore splits), exact/prefix boosts, scope-first
//! permission filtering, and stale-revision protection on publish.

use crate::database::DbError;
use duckdb::Connection;
use icu_casemap::CaseMapper;
use icu_normalizer::ComposingNormalizer;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone)]
pub struct SearchDocumentInput {
    pub doc_key: String,
    pub domain: String,
    pub scope: String,
    pub entity_id: String,
    pub title: String,
    pub body: String,
    pub content_revision: i64,
    pub content_hash: String,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreparedPosting {
    pub token_key: String,
    pub field: &'static str,
    pub tf: i64,
    pub positions: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub doc_key: String,
    pub domain: String,
    pub scope: String,
    pub entity_id: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x3040..=0x309F
            | 0x30A0..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

pub fn normalize_nfkc_lower(input: &str) -> String {
    let nfkc = ComposingNormalizer::new_nfkc();
    let norm = nfkc.normalize(input);
    let cm = CaseMapper::new();
    cm.fold_string(&norm).into_owned()
}

/// Tokenizes text outside any database transaction:
/// - ICU NFKC + casefold
/// - CJK runs emit unigrams + overlapping bigrams + trigrams (full 1-2 char Chinese recall)
/// - ASCII/alphanumeric identifiers keep whole dotted/hyphenated tokens (`gpt-4o`, `ds3806`)
///   PLUS alphanumeric sub-tokens (`gpt`, `4o`, `ds`, `3806`) for exact & prefix scoring.
pub fn tokenize_text_with_positions(input: &str) -> BTreeMap<String, Vec<usize>> {
    let norm = normalize_nfkc_lower(input);
    let mut postings: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let chars: Vec<(usize, char)> = norm.char_indices().collect();
    let mut i = 0usize;
    let mut pos = 0usize;

    while i < chars.len() {
        let ch = chars[i].1;
        if is_cjk(ch) {
            let start_i = i;
            while i < chars.len() && is_cjk(chars[i].1) {
                i += 1;
            }
            let run: Vec<char> = chars[start_i..i].iter().map(|(_, c)| *c).collect();
            for idx in 0..run.len() {
                let p = pos + idx;
                let u: String = [run[idx]].into_iter().collect();
                postings.entry(format!("c1:{u}")).or_default().push(p);
                if idx + 1 < run.len() {
                    let bi: String = run[idx..idx + 2].iter().collect();
                    postings.entry(format!("c2:{bi}")).or_default().push(p);
                }
                if idx + 2 < run.len() {
                    let tri: String = run[idx..idx + 3].iter().collect();
                    postings.entry(format!("c3:{tri}")).or_default().push(p);
                }
            }
            pos += run.len();
        } else if ch.is_ascii_alphanumeric() {
            let start_byte = chars[i].0;
            while i < chars.len()
                && (chars[i].1.is_ascii_alphanumeric() || matches!(chars[i].1, '-' | '_' | '.'))
            {
                i += 1;
            }
            let end_byte = if i < chars.len() { chars[i].0 } else { norm.len() };
            let raw_ident = norm[start_byte..end_byte].trim_end_matches(|c| matches!(c, '-' | '_' | '.'));
            if !raw_ident.is_empty() {
                let my_pos = pos;
                postings.entry(format!("w:{raw_ident}")).or_default().push(my_pos);
                for sub in raw_ident.split(|c| matches!(c, '-' | '_' | '.')).filter(|s| !s.is_empty()) {
                    if sub != raw_ident {
                        postings.entry(format!("w:{sub}")).or_default().push(my_pos);
                    }
                    // Split alpha<->digit transitions for model codes (e.g., `ds3806` -> `ds`, `3806`)
                    let mut seg_start = 0usize;
                    let sub_bytes = sub.as_bytes();
                    for j in 1..sub_bytes.len() {
                        if sub_bytes[j].is_ascii_digit() != sub_bytes[j - 1].is_ascii_digit() {
                            let part = &sub[seg_start..j];
                            if part != sub && !part.is_empty() {
                                postings.entry(format!("w:{part}")).or_default().push(my_pos);
                            }
                            seg_start = j;
                        }
                    }
                    if seg_start > 0 && seg_start < sub.len() {
                        postings.entry(format!("w:{}", &sub[seg_start..])).or_default().push(my_pos);
                    }
                }
                pos += 1;
            }
        } else {
            i += 1;
        }
    }
    postings
}

pub fn prepare_document_postings(doc: &SearchDocumentInput) -> Vec<PreparedPosting> {
    let mut out = Vec::new();
    for (tok, positions) in tokenize_text_with_positions(&doc.title) {
        out.push(PreparedPosting {
            token_key: tok,
            field: "title",
            tf: positions.len() as i64,
            positions,
        });
    }
    for (tok, positions) in tokenize_text_with_positions(&doc.body) {
        out.push(PreparedPosting {
            token_key: tok,
            field: "body",
            tf: positions.len() as i64,
            positions,
        });
    }
    out
}

/// Atomically publishes content & postings inside a domain transaction.
/// Verifies current `content_revision` so stale out-of-tx tokenization never overwrites newer state!
pub fn publish_document_postings_in_tx(
    tx: &Connection,
    doc: &SearchDocumentInput,
    postings: &[PreparedPosting],
    now_ms: i64,
) -> Result<bool, DbError> {
    let existing_rev: Option<(i64, String)> = match tx.query_row(
        "SELECT content_revision, content_hash FROM search_documents WHERE doc_key = ?",
        duckdb::params![doc.doc_key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ) {
        Ok(v) => Some(v),
        Err(duckdb::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(DbError::from(e)),
    };
    if let Some((cur_rev, _)) = existing_rev
        && cur_rev > doc.content_revision
    {
        // Stale index build: newer content already published!
        return Ok(false);
    }

    tx.execute(
        "INSERT INTO search_documents (
           doc_key, domain, scope, entity_id, title, body, content_revision, content_hash, metadata_json, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_key) DO UPDATE SET
           domain = excluded.domain,
           scope = excluded.scope,
           entity_id = excluded.entity_id,
           title = excluded.title,
           body = excluded.body,
           content_revision = excluded.content_revision,
           content_hash = excluded.content_hash,
           metadata_json = excluded.metadata_json,
           updated_at_ms = excluded.updated_at_ms",
        duckdb::params![
            doc.doc_key,
            doc.domain,
            doc.scope,
            doc.entity_id,
            doc.title,
            doc.body,
            doc.content_revision,
            doc.content_hash,
            doc.metadata_json,
            now_ms
        ],
    )?;
    tx.execute(
        "DELETE FROM search_postings WHERE doc_key = ?",
        duckdb::params![doc.doc_key],
    )?;
    for p in postings {
        let pos_json = serde_json::to_string(&p.positions).unwrap_or_else(|_| "[]".to_owned());
        tx.execute(
            "INSERT INTO search_postings (token_key, doc_key, field, tf, positions_json)
             VALUES (?, ?, ?, ?, ?)",
            duckdb::params![p.token_key, doc.doc_key, p.field, p.tf, pos_json],
        )?;
    }
    Ok(true)
}

pub fn delete_document_postings_in_tx(
    tx: &Connection,
    doc_key: &str,
) -> Result<(), DbError> {
    tx.execute(
        "DELETE FROM search_postings WHERE doc_key = ?",
        duckdb::params![doc_key],
    )?;
    tx.execute(
        "DELETE FROM search_documents WHERE doc_key = ?",
        duckdb::params![doc_key],
    )?;
    Ok(())
}

/// Scope-first filtered search returning ranked results with title weighting and bounded snippets.
pub fn query_postings(
    conn: &Connection,
    allowed_scopes: &[&str],
    domain_filter: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, DbError> {
    if allowed_scopes.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let query_norm = normalize_nfkc_lower(query).trim().to_owned();
    if query_norm.is_empty() {
        return Ok(Vec::new());
    }
    let q_tokens = tokenize_text_with_positions(&query_norm);
    // Prefer multi-char tokens (c3/c2/w) when present; fall back to unigram (c1) for 1-char queries.
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
        return Ok(Vec::new());
    }

    let scope_placeholders = vec!["?"; allowed_scopes.len()].join(",");
    let tok_placeholders = vec!["?"; search_tokens.len()].join(",");
    let domain_clause = if domain_filter.is_some() {
        " AND d.domain = ?"
    } else {
        ""
    };
    // Filter by allowed scope FIRST via indexed `search_documents(scope)` + `search_postings(token_key)`,
    // including prefix lookup on ASCII word tokens (`LIKE 'w:foo%'`).
    let sql = format!(
        "SELECT d.doc_key, d.domain, d.scope, d.entity_id, d.title, d.body,
                SUM(p.tf * CASE WHEN p.field = 'title' THEN 3.0 ELSE 1.0 END) AS base_score,
                COUNT(DISTINCT p.token_key) AS matched_tokens
         FROM search_documents d
         JOIN search_postings p ON p.doc_key = d.doc_key
         WHERE d.scope IN ({scope_placeholders}){domain_clause}
           AND p.token_key IN ({tok_placeholders})
         GROUP BY d.doc_key, d.domain, d.scope, d.entity_id, d.title, d.body"
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut params: Vec<&dyn duckdb::ToSql> = Vec::new();
    for s in allowed_scopes {
        params.push(s as &dyn duckdb::ToSql);
    }
    if let Some(ref dom) = domain_filter {
        params.push(dom as &dyn duckdb::ToSql);
    }
    for tok in &search_tokens {
        params.push(tok as &dyn duckdb::ToSql);
    }

    let mut rows: Vec<(String, String, String, String, String, String, f64, i64)> = stmt
        .query_map(duckdb::params_from_iter(params), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Also include bounded prefix matches for short ASCII model queries (e.g. `ds38` -> `w:ds3806`)
    if query_norm.is_ascii() && query_norm.len() >= 2 && !query_norm.contains(' ') {
        let prefix_pattern = format!("w:{query_norm}%");
        let seen: HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
        let prefix_sql = format!(
            "SELECT DISTINCT d.doc_key, d.domain, d.scope, d.entity_id, d.title, d.body,
                    CAST(p.tf AS DOUBLE) * CASE WHEN p.field = 'title' THEN 2.0 ELSE 0.8 END AS base_score,
                    1 AS matched_tokens
             FROM search_documents d
             JOIN search_postings p ON p.doc_key = d.doc_key
             WHERE d.scope IN ({scope_placeholders}){domain_clause}
               AND p.token_key LIKE ?
             LIMIT ?"
        );
        let mut p_stmt = conn.prepare(&prefix_sql)?;
        let mut p_params: Vec<&dyn duckdb::ToSql> = Vec::new();
        for s in allowed_scopes {
            p_params.push(s as &dyn duckdb::ToSql);
        }
        if let Some(ref dom) = domain_filter {
            p_params.push(dom as &dyn duckdb::ToSql);
        }
        p_params.push(&prefix_pattern);
        let limit_i = (limit * 2) as i64;
        p_params.push(&limit_i);
        let extra: Vec<_> = p_stmt
            .query_map(duckdb::params_from_iter(p_params), |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for item in extra {
            if !seen.contains(&item.0) {
                rows.push(item);
            }
        }
    }

    let mut hits: Vec<SearchHit> = rows
        .into_iter()
        .map(|(doc_key, domain, scope, entity_id, title, body, base_score, matched_tokens)| {
            let title_fold = normalize_nfkc_lower(&title);
            let body_fold = normalize_nfkc_lower(&body);
            let exact_title_boost = if title_fold == query_norm {
                20.0
            } else if title_fold.contains(&query_norm) {
                8.0
            } else {
                0.0
            };
            let phrase_body_boost = if body_fold.contains(&query_norm) { 4.0 } else { 0.0 };
            let coverage_boost = (matched_tokens as f64) / (search_tokens.len() as f64) * 5.0;
            let score = base_score + exact_title_boost + phrase_body_boost + coverage_boost;
            let snippet = build_snippet(&body, &query_norm, 120);
            SearchHit {
                doc_key,
                domain,
                scope,
                entity_id,
                title,
                snippet,
                score,
            }
        })
        .collect();

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.doc_key.cmp(&b.doc_key))
    });
    hits.truncate(limit);
    Ok(hits)
}

fn build_snippet(body: &str, _query_norm: &str, max_chars: usize) -> String {
    let chars: Vec<char> = body.chars().take(max_chars).collect();
    let s: String = chars.into_iter().collect();
    if body.chars().count() > max_chars {
        format!("{s}…")
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{DuckDbEngine, DuckDbPoolConfig};
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mybuddy-search-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn supports_cjk_1_2_char_nfkc_model_codes_scope_filter_and_revision_guard() {
        let dir = temp_dir("in06");
        let (engine, _) =
            DuckDbEngine::open_or_initialize(dir.join("app.duckdb"), DuckDbPoolConfig::default()).unwrap();

        let docs = vec![
            SearchDocumentInput {
                doc_key: "doc-cjk-1".into(),
                domain: "memory".into(),
                scope: "ws-allowed".into(),
                entity_id: "m1".into(),
                title: "项目进度".into(),
                body: "核对ＭＦＭ６４００设备与报销单".into(),
                content_revision: 2,
                content_hash: "h2".into(),
                metadata_json: None,
            },
            SearchDocumentInput {
                doc_key: "doc-forbidden".into(),
                domain: "memory".into(),
                scope: "ws-secret".into(),
                entity_id: "m2".into(),
                title: "核对报告".into(),
                body: "机密项目进度 MFM6400".into(),
                content_revision: 1,
                content_hash: "h1".into(),
                metadata_json: None,
            },
        ];

        {
            let mut w = engine.checkout_writer(Duration::from_secs(2)).unwrap();
            let tx = w.conn_mut().transaction().unwrap();
            for d in &docs {
                let postings = prepare_document_postings(d);
                assert!(publish_document_postings_in_tx(&tx, d, &postings, 100).unwrap());
            }
            // Stale revision=1 attempt for doc-cjk-1 (already at rev=2) MUST be rejected cleanly!
            let stale_doc = SearchDocumentInput {
                content_revision: 1,
                body: "stale old body".into(),
                ..docs[0].clone()
            };
            let stale_postings = prepare_document_postings(&stale_doc);
            assert!(!publish_document_postings_in_tx(&tx, &stale_doc, &stale_postings, 200).unwrap());
            tx.commit().unwrap();
        }

        let r = engine.checkout_reader(Duration::from_secs(2)).unwrap();
        // 2-char Chinese query finds allowed doc only (never leaks ws-secret!)
        let cjk2 = query_postings(r.conn(), &["ws-allowed"], None, "进度", 10).unwrap();
        assert_eq!(cjk2.len(), 1);
        assert_eq!(cjk2[0].doc_key, "doc-cjk-1");

        // 1-char Chinese query
        let cjk1 = query_postings(r.conn(), &["ws-allowed"], None, "销", 10).unwrap();
        assert_eq!(cjk1.len(), 1);
        assert_eq!(cjk1[0].doc_key, "doc-cjk-1");

        // Fullwidth NFKC + ASCII model-code prefix query (`mfm6` -> matches `ＭＦＭ６４００`)
        let model_hits = query_postings(r.conn(), &["ws-allowed"], None, "mfm6", 10).unwrap();
        assert_eq!(model_hits.len(), 1);
        assert_eq!(model_hits[0].doc_key, "doc-cjk-1");

        drop(r);
        drop(engine);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
