use super::{
    CLAIMED, ExtractionLease, Receipt, Turn, digest, live, note_publication, now_ms,
    read_claimed_batch, receipt, receipt_scope,
};
use crate::{Result, memory_record_write};
use duckdb::{Connection, OptionalExt, Transaction, params};
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    kind: String,
    title: String,
    content: String,
    pub(super) scope_type: String,
    pub(super) scope_id: Option<String>,
    confidence: f64,
    importance: i64,
    explicit: bool,
    operation_hint: String,
    replaces: Option<String>,
    evidence: Option<Evidence>,
    action: Action,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    turn_id: String,
    quote: String,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Review,
    Create,
    Update {
        target_id: String,
        expected_revision: i64,
    },
    Resolve {
        target_id: String,
        expected_revision: i64,
    },
    Duplicate {
        target_id: String,
        expected_revision: i64,
    },
}

impl Action {
    fn target(&self) -> Option<(&str, i64)> {
        match self {
            Self::Update {
                target_id,
                expected_revision,
            }
            | Self::Resolve {
                target_id,
                expected_revision,
            }
            | Self::Duplicate {
                target_id,
                expected_revision,
            } => Some((target_id, *expected_revision)),
            Self::Review | Self::Create => None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    scope_type: &'static str,
    scope_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Existing<'a> {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    content_hash: String,
    revision: i64,
    scope_type: &'a str,
    scope_id: Option<&'a str>,
    mutation_allowed: bool,
}

struct Basis {
    stamp: String,
    scopes: Vec<Scope>,
    turns: Vec<Turn>,
    withheld: Vec<(String, &'static str)>,
    records: Vec<Json>,
}

enum Availability {
    Ready(Basis),
    Stale,
    Blocked(&'static str),
}

impl Availability {
    fn rejection(&self) -> Json {
        match self {
            Self::Stale => json!({"status":"stale"}),
            Self::Blocked(reason) => json!({"status":"blocked","reason":reason}),
            Self::Ready(_) => unreachable!(),
        }
    }
}

static SENSITIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:api[ _-]?key|password|passwd|secret|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|recovery[ _-]?(?:code|seed)|",
        r"私钥|恢复码|助记词|密钥|密码|口令|令牌|验证码|身份证|护照|银行卡|信用卡|病历|诊断|用药|医疗|健康状况|银行账户|存款|资产|",
        r"medical|diagnosis|medication|diabetes|insulin|cancer|hiv|antidepressant|糖尿病|胰岛素|癌症|艾滋|抑郁|passport|social security|credit card|bank account|保密|机密)|",
        r#"(?:^|[^\w])(?:set[ _-]?cookie|cookie)["']?\s*[:=：]\s*["']?[^\s"']+|"#,
        r"\b(?:authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{16,}|",
        r"\b(?:session|auth|csrf|xsrf|tracking)[ _-]?(?:id|key|token|cookie)\s*[:=：]\s*\S{8,}|",
        r#"\b(?:token|secret|key|password|passwd|signature)\s*[:=]\s*["']?[A-Fa-f0-9]{32,}\b|"#,
        r"\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b|",
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|",
        r"\b[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}\b|",
        r"(?:^|[^\w-])(?:[0-9][ -]?){12}[0-9](?:[ -]?[0-9]){0,6}(?:$|[^\w-])"
    )).expect("valid memory sensitivity patterns")
});

fn ordinary_scopes(
    db: &Connection,
    user_id: &str,
    task_id: &str,
) -> Result<Option<(Vec<Scope>, Vec<String>)>> {
    if user_id != "user-local-primary"
        || task_id == crate::DOTS_TASK_ID
        || ["gateway-chat-", "bot-conversation-", "bot-peer-"]
            .iter()
            .any(|prefix| task_id.starts_with(*prefix))
    {
        return Ok(None);
    }
    let binding: Option<(Option<String>, Option<String>)> = db.query_row(
        "SELECT NULLIF(project_id,''),NULLIF(space_id,'') FROM tasks t WHERE t.id=?1 AND t.archived=0
         AND NOT EXISTS(SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM gateway_dots_tasks g WHERE g.task_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM bot_conversations c WHERE c.conversation_id=t.id)
         AND NOT EXISTS(SELECT 1 FROM bot_channel_bindings c WHERE c.channel_type='desktop' AND c.channel_identifier=?2)",
        params![task_id, json!([user_id, task_id]).to_string()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((project, workspace)) = binding else {
        return Ok(None);
    };
    let mut scopes = vec![
        Scope {
            scope_type: "global",
            scope_id: None,
        },
        Scope {
            scope_type: "task",
            scope_id: Some(task_id.to_owned()),
        },
    ];
    let mut parents = Vec::new();
    if let Some(space) = &workspace {
        let mut statement = db.prepare("WITH RECURSIVE parents(id,parent_id,archived) AS (
           SELECT id,parent_id,archived FROM spaces WHERE id=?1
           UNION SELECT s.id,s.parent_id,s.archived FROM spaces s JOIN parents p ON s.id=p.parent_id)
           SELECT id,parent_id,archived FROM parents ORDER BY id")?;
        let rows = statement
            .query_map([space], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        if !rows.iter().any(|(_, parent, _)| parent.is_none())
            || rows.iter().any(|(_, _, archived)| *archived != 0)
        {
            return Ok(None);
        }
        parents.extend(rows.into_iter().map(|(id, _, _)| id));
    }
    if let Some(project) = project {
        scopes.push(Scope {
            scope_type: "project",
            scope_id: Some(project),
        });
    } else if let Some(workspace) = workspace {
        scopes.push(Scope {
            scope_type: "workspace",
            scope_id: Some(workspace),
        });
    }
    Ok(Some((scopes, parents)))
}

fn withdrawal_cutoff(
    db: &Connection,
    scopes: &[Scope],
    workspace_parents: &[String],
) -> Result<Option<i64>> {
    let scope_keys = scopes
        .iter()
        .map(|scope| (scope.scope_type, scope.scope_id.as_deref().unwrap_or("")))
        .chain(
            workspace_parents
                .iter()
                .map(|id| ("workspace", id.as_str())),
        )
        .collect::<Vec<_>>();
    Ok(db.query_row("WITH scopes AS (SELECT json_extract_string(value,'$[0]') AS kind,
        json_extract_string(value,'$[1]') AS id FROM json_each(?1)), boundaries AS (
        SELECT w.cutoff_at FROM memory_forget_watermarks w JOIN scopes s ON w.scope_type=s.kind AND w.scope_id=s.id
        UNION ALL SELECT w.cutoff_at FROM memory_forget_targets w JOIN scopes s ON w.scope_type=s.kind AND w.scope_id=s.id
        ) SELECT MAX(cutoff_at) FROM boundaries", [serde_json::to_string(&scope_keys)?], |row| row.get(0))?)
}

fn existing(db: &Connection, scopes: &[Scope], cutoff: Option<i64>, now: i64) -> Result<Vec<Json>> {
    let mut records = Vec::new();
    let mut statement = db.prepare("SELECT m.id,m.kind,m.title,m.content,m.status,m.content_hash,
        COALESCE((SELECT MAX(r.revision) FROM memory_revisions r WHERE r.memory_id=m.id),0),
        (SELECT COUNT(*) FROM memory_scopes p WHERE p.memory_id=m.id),s.binding,
        EXISTS(SELECT 1 FROM memory_capture_receipts c WHERE c.memory_id=m.id AND c.suppressed=0),
        (json_extract_string(m.metadata_json,'$.botAutomaticScopePolicy') IS NOT NULL
          OR json_extract_string(m.metadata_json,'$.gatewayOrigin') IS NOT NULL
          OR json_extract_string(m.metadata_json,'$.workId') IS NOT NULL
          OR COALESCE(m.source_task_id,'') LIKE 'bot-%' OR COALESCE(m.source_id,'') LIKE 'bot-%'
          OR COALESCE(m.source_task_id,'') LIKE 'gateway-chat-%' OR m.source_task_id IS NOT DISTINCT FROM 'mybuddy-dots'
          OR EXISTS(SELECT 1 FROM work_execution_bindings b WHERE b.task_id=m.source_task_id)
          OR EXISTS(SELECT 1 FROM gateway_sidebar_conversations g WHERE g.task_id=m.source_task_id))
        FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
        WHERE s.scope_type=?1 AND s.scope_id IS NOT DISTINCT FROM ?2 AND m.status='active'
          AND (?3 IS NULL OR m.created_at>?3)
          AND (m.valid_from IS NULL OR m.valid_from<=?4) AND (m.valid_until IS NULL OR m.valid_until>?4)
          AND COALESCE(json_extract_string(m.metadata_json,'$.dotsPrivateGateway'),'false')<>'true'
          AND NOT EXISTS(SELECT 1 FROM memory_scopes p WHERE p.memory_id=m.id AND p.scope_type IN ('bot','work','team','conversation'))
        ORDER BY m.updated_at DESC,m.id,s.id LIMIT 40")?;
    for scope in scopes {
        let rows = statement.query_map(
            params![scope.scope_type, scope.scope_id, cutoff, now],
            |row| {
                let id: String = row.get(0)?;
                Ok(Existing {
                    mutation_allowed: row.get::<_, i64>(7)? == 1
                        && row.get::<_, String>(8)? == "owned"
                        && !row.get::<_, bool>(9)?
                        && !row.get::<_, bool>(10)?,
                    id,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    status: row.get(4)?,
                    content_hash: row.get(5)?,
                    revision: row.get(6)?,
                    scope_type: scope.scope_type,
                    scope_id: scope.scope_id.as_deref(),
                })
            },
        )?;
        for row in rows {
            let row = row?;
            if !SENSITIVE.is_match(&row.title) && !SENSITIVE.is_match(&row.content) {
                records.push(serde_json::to_value(row)?);
            }
        }
    }
    Ok(records)
}

fn basis(
    db: &Connection,
    user_id: &str,
    lease: &ExtractionLease,
    current: &Receipt,
    now: i64,
) -> Result<Availability> {
    if current.status != CLAIMED || current.claim.owner != lease.owner || !live(&current.claim, now)
    {
        return Ok(Availability::Stale);
    }
    let Some(captured) = read_claimed_batch(db, user_id, &lease.task_id, &current.claim, false)?
    else {
        return Ok(Availability::Stale);
    };
    let Some((scopes, workspace_parents)) = ordinary_scopes(db, user_id, &lease.task_id)? else {
        return Ok(Availability::Blocked("unsupportedSourceAuthority"));
    };
    let cutoff = withdrawal_cutoff(db, &scopes, &workspace_parents)?;
    let mut turns = Vec::new();
    let mut withheld = Vec::new();
    for mut turn in captured {
        let metadata: Json = serde_json::from_str(&turn.metadata_json)?;
        let reason = if cutoff.is_some_and(|cutoff| turn.captured_at <= cutoff as f64) {
            Some("withdrawnSourceRequiresRedaction")
        } else if SENSITIVE.is_match(&turn.user_text) {
            Some("sensitiveSourceRequiresRedaction")
        } else if ["gatewayOrigin", "botId", "workId"]
            .iter()
            .any(|key| !metadata[*key].is_null())
        {
            Some("unsupportedSourceAuthority")
        } else if turn.user_text.trim().is_empty() {
            Some("emptyUserSource")
        } else {
            None
        };
        if let Some(reason) = reason {
            withheld.push((turn.id, reason));
            continue;
        }
        turn.assistant_text.clear();
        turn.metadata_json = "{}".to_owned();
        turns.push(turn);
    }
    let records = existing(db, &scopes, cutoff, now)?;
    let stamp = digest(&json!([
        lease.token,
        lease.owner,
        current.claim.scope,
        current.claim.turns,
        scopes,
        workspace_parents,
        records,
        withheld
    ]))?;
    Ok(Availability::Ready(Basis {
        stamp,
        scopes,
        turns,
        withheld,
        records,
    }))
}

pub(super) fn read_basis(db: &Connection, user_id: &str, lease: &ExtractionLease) -> Result<Json> {
    let tx = db.unchecked_transaction()?;
    let scope = receipt_scope(user_id, &lease.task_id);
    let state = match receipt(&tx, &scope, &lease.token)? {
        Some(current) => basis(&tx, user_id, lease, &current, now_ms())?,
        None => Availability::Stale,
    };
    tx.commit()?;
    Ok(match state {
        Availability::Ready(basis) => {
            json!({"kind":"extractionBasis","status":"ready", "basisStamp":basis.stamp,
            "scopes":basis.scopes,"turns":basis.turns,"records":basis.records,"withheldSourceCount":basis.withheld.len()})
        }
        other => {
            let mut reply = other.rejection();
            reply["kind"] = json!("extractionBasis");
            reply
        }
    })
}

const KINDS: &[&str] = &[
    "identity",
    "preference",
    "fact",
    "decision",
    "constraint",
    "risk",
    "open_question",
    "progress",
    "procedure",
];
const OPERATIONS: &[&str] = &["create", "update", "supersede", "resolve", "forget"];

impl Candidate {
    fn valid(&self, basis: &Basis) -> bool {
        KINDS.contains(&self.kind.as_str())
            && OPERATIONS.contains(&self.operation_hint.as_str())
            && !self.title.trim().is_empty()
            && self.title.chars().count() <= 240
            && self.content.chars().count() <= 6000
            && self
                .replaces
                .as_ref()
                .is_none_or(|text| text.chars().count() <= 240 && !SENSITIVE.is_match(text))
            && (0..=3).contains(&self.importance)
            && (0.0..=1.0).contains(&self.confidence)
            && !SENSITIVE.is_match(&self.title)
            && !SENSITIVE.is_match(&self.content)
            && basis
                .scopes
                .iter()
                .any(|scope| scope.scope_type == self.scope_type && scope.scope_id == self.scope_id)
            && self.evidence.as_ref().is_none_or(|evidence| {
                let quote = &evidence.quote;
                quote == quote.trim()
                    && (2..=1200).contains(&quote.chars().count())
                    && !SENSITIVE.is_match(quote)
                    && basis
                        .turns
                        .iter()
                        .any(|turn| turn.id == evidence.turn_id && turn.user_text.contains(quote))
            })
            && match self.action {
                Action::Review => true,
                _ if self.evidence.is_none() || !self.explicit && self.confidence < 0.68 => false,
                Action::Create => self.operation_hint == "create",
                Action::Update { .. } => self.operation_hint == "update",
                Action::Resolve { .. } => self.operation_hint == "resolve",
                Action::Duplicate { .. } => {
                    !matches!(self.operation_hint.as_str(), "forget" | "supersede")
                }
            }
    }

    fn content_hash(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(format!("{}\n{}\n{}", self.kind, self.title, self.content))
        )
    }

    fn safely_matches(&self, record: &Json) -> bool {
        let title = self.replaces.as_ref().unwrap_or(&self.title);
        let exact = record["title"] == *title || record["content"] == *title;
        match &self.action {
            Action::Update { .. } => record["kind"] == self.kind && exact,
            Action::Resolve { .. } => record["kind"] == "open_question" && exact,
            Action::Duplicate { .. } => {
                record["kind"] == self.kind
                    && (record["contentHash"] == self.content_hash()
                        || !self.content.is_empty() && record["content"] == self.content)
            }
            _ => false,
        }
    }
}

fn target_record<'a>(
    basis: &'a Basis,
    candidate: &Candidate,
    id: &str,
    revision: i64,
) -> Option<&'a Json> {
    basis.records.iter().find(|record| {
        record["id"] == id
            && record["revision"] == revision
            && record["status"] == "active"
            && record["mutationAllowed"] == true
            && record["scopeType"] == candidate.scope_type
            && record["scopeId"] == json!(candidate.scope_id)
            && candidate.safely_matches(record)
    })
}

fn record_save(
    tx: &Transaction<'_>,
    candidate: &Candidate,
    id: &str,
    candidate_id: &str,
    task_id: &str,
    user_id: &str,
    now: i64,
) -> Result<()> {
    let evidence = candidate
        .evidence
        .as_ref()
        .ok_or("Missing grounded memory evidence")?;
    let agent = if candidate.explicit { "user" } else { "agent" };
    let revision = json!({"revisionId":format!("mrev_{candidate_id}"),"changedAt":now,"changedBy":agent,
        "reason":format!("candidate:{candidate_id}")});
    let request = match &candidate.action {
        Action::Create => json!({"kind":"create","userId":user_id,"revision":revision,
            "scope":{"id":format!("mscope_{candidate_id}"),"scopeType":candidate.scope_type,"scopeId":candidate.scope_id},
            "record":{"id":id,"kind":candidate.kind,"title":candidate.title,"content":candidate.content,
                "status":"active","importance":candidate.importance,"confidence":candidate.confidence,"explicit":candidate.explicit,
                "contentHash":candidate.content_hash(),"updatedAt":now,"createdAt":now,"metadataJson":"{}","sourceType":agent,
                "sourceTaskId":task_id,"evidence":[{"id":format!("mev_task_{candidate_id}"),"evidenceKind":"task","refId":task_id,"createdAt":now},
                  {"id":format!("mev_{candidate_id}"),"evidenceKind":"conversation","refId":evidence.turn_id,"excerpt":evidence.quote,"createdAt":now}]}}),
        Action::Update {
            expected_revision, ..
        }
        | Action::Resolve {
            expected_revision, ..
        } => {
            let prior: (String, String, String, String, i64, f64, bool, Option<f64>, Option<f64>, String) = tx.query_row(
                "SELECT kind,title,content,content_hash,importance,confidence,explicit,valid_from,valid_until,metadata_json
                 FROM memory_records WHERE id=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,
                    r.get(5)?,crate::database::row_bool(r,6)?,r.get(7)?,r.get(8)?,r.get(9)?)))?;
            let resolve = matches!(candidate.action, Action::Resolve { .. });
            json!({"kind":"update","expectedRevision":expected_revision,"revision":revision,"record":{
                "id":id,"kind":if resolve { &prior.0 } else { &candidate.kind },
                "title":if resolve { &prior.1 } else { &candidate.title }, "content":if resolve { &prior.2 } else { &candidate.content },
                "contentHash":if resolve { prior.3 } else { candidate.content_hash() },"status":if resolve {"resolved"} else {"active"},
                "importance":prior.4.max(candidate.importance),"confidence":prior.5.max(candidate.confidence),
                "explicit":prior.6 || candidate.explicit,"validFrom":prior.7,"validUntil":prior.8,"metadataJson":prior.9,"updatedAt":now}})
        }
        Action::Duplicate { .. } => Json::Null,
        Action::Review => unreachable!(),
    };
    if !request.is_null()
        && !matches!(
            memory_record_write::save_in_tx(tx, serde_json::from_value(request)?)?,
            memory_record_write::Reply::Applied { .. }
        )
    {
        return Err("Core memory writer did not apply the grounded extraction".into());
    }
    if !matches!(candidate.action, Action::Create) {
        tx.execute(
            "INSERT INTO memory_evidence(id,memory_id,evidence_kind,ref_id,excerpt,created_at)
            SELECT ?1,?2,'conversation',?3,?4,?5 WHERE NOT EXISTS(SELECT 1 FROM memory_evidence
              WHERE memory_id=?2 AND evidence_kind='conversation' AND ref_id=?3 AND excerpt=?4)",
            params![
                format!("mev_{candidate_id}"),
                id,
                evidence.turn_id,
                evidence.quote,
                now
            ],
        )?;
    }
    Ok(())
}

pub(super) fn publish(
    tx: &Transaction<'_>,
    user_id: &str,
    lease: &ExtractionLease,
    now: i64,
    stamp: &str,
    candidates: &[Candidate],
) -> Result<Json> {
    let scope = receipt_scope(user_id, &lease.task_id);
    let Some(current) = receipt(tx, &scope, &lease.token)? else {
        return Ok(json!({"status":"stale"}));
    };
    if current.claim.owner != lease.owner {
        return Ok(json!({"status":"stale"}));
    }
    if candidates.len() > 24 || stamp.len() != 64 {
        return Ok(json!({"status":"blocked","reason":"invalidPublication"}));
    }
    let payload_hash = digest(&json!([stamp, candidates]))?;
    if current.status == "published" {
        return if current.request_hash == payload_hash {
            current
                .claim
                .publication
                .ok_or_else(|| "Missing extraction publication receipt".into())
        } else {
            Ok(json!({"status":"conflict","reason":"publicationPayloadChanged"}))
        };
    }
    let state = basis(tx, user_id, lease, &current, now)?;
    let Availability::Ready(basis) = state else {
        return Ok(state.rejection());
    };
    if basis.stamp != stamp {
        return Ok(json!({"status":"stale"}));
    }
    if basis.turns.is_empty() && !candidates.is_empty() {
        return Ok(json!({"status":"blocked","reason":"noEligibleSource"}));
    }
    let mut target_ids = HashSet::new();
    for candidate in candidates {
        if !candidate.valid(&basis) {
            return Ok(json!({"status":"blocked","reason":"invalidCandidate"}));
        }
        if let Some((id, revision)) = candidate.action.target() {
            if !target_ids.insert(id) || target_record(&basis, candidate, id, revision).is_none() {
                return Ok(json!({"status":"conflict","reason":"candidateTargetChanged"}));
            }
        }
    }

    let mut changed_scopes = BTreeSet::new();
    let mut committed = 0;
    let mut review = 0;
    for (index, candidate) in candidates.iter().enumerate() {
        let identity = digest(&json!([scope, lease.token, index]))?;
        let candidate_id = format!("mcand_{identity}");
        let new_id = format!("mem_{identity}");
        let (status, resolved_id) = match &candidate.action {
            Action::Review => {
                review += 1;
                ("needs_review", None)
            }
            // The prompt only sees a bounded set of records. An existing exact match
            // can absorb a repeat without exposing its identity or adding evidence to it.
            Action::Create if already_recorded(tx, candidate, now)? => ("rejected", None),
            action => {
                let record_id = action.target().map_or(new_id.as_str(), |(id, _)| id);
                record_save(
                    tx,
                    candidate,
                    record_id,
                    &candidate_id,
                    &lease.task_id,
                    user_id,
                    now,
                )?;
                if matches!(action, Action::Duplicate { .. }) {
                    ("rejected", Some(record_id))
                } else {
                    committed += 1;
                    changed_scopes.insert(candidate.scope_type.as_str());
                    ("committed", Some(record_id))
                }
            }
        };
        let source_turn_ids = candidate
            .evidence
            .as_ref()
            .map(|evidence| vec![&evidence.turn_id])
            .unwrap_or_else(|| basis.turns.iter().map(|turn| &turn.id).collect());
        let raw = json!({"sourceTurnIds":source_turn_ids,"userEvidence":candidate.evidence.as_ref().map(|evidence| &evidence.quote),
            "manualConfirmationRequired":matches!(candidate.operation_hint.as_str(), "forget" | "supersede")});
        tx.execute("INSERT INTO memory_candidates(id,task_id,kind,title,content,scope_type,scope_id,confidence,importance,
          explicit,operation_hint,replaces,status,raw_json,created_at,resolved_at,resolved_memory_id)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
          params![candidate_id,lease.task_id,candidate.kind,candidate.title,candidate.content,candidate.scope_type,candidate.scope_id,
            candidate.confidence,candidate.importance,i64::from(candidate.explicit),candidate.operation_hint,candidate.replaces,
            status,raw.to_string(),now,(status!="needs_review").then_some(now),resolved_id])?;
    }
    finish_sources(tx, lease, &current, &basis, now)?;
    let status = if basis.turns.is_empty() {
        "filtered"
    } else {
        "published"
    };
    let result = json!({"status":status,"extractedCount":candidates.len(),"committedCount":committed,
        "reviewCount":review,"changedScopes":changed_scopes,"skippedSourceCount":basis.withheld.len()});
    let terminal = json!({"owner":lease.owner,"generation":"","expires_at":0,"scope":"","turns":[],"publication":result});
    let saved = tx.execute(
        "UPDATE operation_receipts SET status='published',request_hash=?1,result_json=?2
        WHERE caller_scope=?3 AND operation_id=?4 AND batch_index=0 AND status='claimed'",
        params![payload_hash, terminal.to_string(), scope, lease.token],
    )?;
    if saved != 1 {
        return Err("Memory extraction acknowledgement was not persisted".into());
    }
    Ok(result)
}

fn already_recorded(db: &Connection, candidate: &Candidate, now: i64) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
        WHERE s.scope_type=?1 AND s.scope_id IS NOT DISTINCT FROM ?2 AND m.kind=?3 AND m.status='active'
          AND (m.content_hash=?4 OR (?5<>'' AND m.content=?5))
          AND (m.valid_from IS NULL OR m.valid_from<=?6) AND (m.valid_until IS NULL OR m.valid_until>?6))",
        params![candidate.scope_type,candidate.scope_id,candidate.kind,candidate.content_hash(),candidate.content,now], |r| r.get(0))?)
}

fn finish_sources(
    tx: &Transaction<'_>,
    lease: &ExtractionLease,
    current: &Receipt,
    basis: &Basis,
    now: i64,
) -> Result<()> {
    if !live(&current.claim, now_ms()) {
        return Err("Memory extraction lease expired before publication".into());
    }
    for source in &current.claim.turns {
        let withheld = basis
            .withheld
            .iter()
            .find(|(id, _)| id == &source.id)
            .map(|(_, reason)| *reason);
        let status = if withheld.is_some() {
            "skipped"
        } else {
            "completed"
        };
        let changed = tx.execute(
            "UPDATE memory_turns SET extraction_state=?1,extracted_at=?2,last_error=?3
            WHERE id=?4 AND task_id=?5 AND attempt_count=?6 AND extraction_state='processing'",
            params![
                status,
                withheld.is_none().then_some(now),
                withheld,
                source.id,
                lease.task_id,
                source.attempt
            ],
        )?;
        if changed != 1 {
            return Err("Memory source changed during publication".into());
        }
    }
    if !basis.turns.is_empty() {
        note_publication(tx, &lease.task_id, now)?;
    }
    Ok(())
}
