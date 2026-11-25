use crate::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Spaces,
    VisibleSpaces { user_id: String },
    Navigation { user_id: String },
}

#[derive(Serialize)]
pub struct WorkspaceData {
    spaces: Vec<Space>,
    #[serde(skip_serializing_if = "Option::is_none")]
    navigation: Option<Navigation>,
}

#[derive(Serialize)]
struct Space {
    id: String,
    name: String,
    path: Option<String>,
    archived: i64,
    parent_id: Option<String>,
    sort_order: i64,
    created_at: i64,
    icon_shape: Option<String>,
    icon_color: Option<String>,
    effective_archived: bool,
    path_missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Navigation {
    foreground_requests: Vec<ForegroundRequest>,
    conversations: Vec<Conversation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForegroundRequest {
    id: String,
    request_id: String,
    message_id: String,
    status: String,
    #[serde(flatten)]
    conversation: Conversation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    conversation_id: String,
    bot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
    space_id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    archived: bool,
}

const CONVERSATION_FILTER: &str = "c.user_id=?1 AND c.conversation_id NOT LIKE 'bot-inbox-%'";
const RECEIPTS: &str = "FROM bot_send_receipts r
    JOIN bot_conversations c ON c.conversation_id=r.conversation_id
    JOIN bot_messages u ON u.message_id=r.user_message_id
    JOIN bot_messages a ON a.message_id=r.assistant_message_id
    WHERE r.user_id=?1 AND c.user_id=?1";

pub fn read(db: &mut Connection, query: Query) -> Result<WorkspaceData> {
    let snapshot = db.transaction()?;
    let mut spaces = read_spaces(&snapshot)?;
    let navigation = match query {
        Query::Spaces => None,
        Query::VisibleSpaces { user_id } => {
            if has_generated_spaces(&snapshot)? {
                let history = read_history_spaces(&snapshot, &user_id)?;
                retain_visible(&snapshot, &user_id, &history, &mut spaces)?;
            }
            None
        }
        Query::Navigation { user_id } => {
            let mut history = read_navigation(&snapshot, &user_id)?;
            if has_generated_spaces(&snapshot)? {
                let history_spaces: HashSet<&str> = history
                    .conversations
                    .iter()
                    .map(|row| row.space_id.as_str())
                    .chain(
                        history
                            .foreground_requests
                            .iter()
                            .map(|row| row.conversation.space_id.as_str()),
                    )
                    .collect();
                retain_visible(&snapshot, &user_id, &history_spaces, &mut spaces)?;
            }
            let visible = spaces
                .iter()
                .map(|space| space.id.as_str())
                .collect::<HashSet<_>>();
            history
                .foreground_requests
                .retain(|row| visible.contains(row.conversation.space_id.as_str()));
            history
                .conversations
                .retain(|row| visible.contains(row.space_id.as_str()));
            Some(history)
        }
    };
    snapshot.commit()?;

    let mut checked_paths = HashMap::new();
    for space in &mut spaces {
        if let Some(path) = space.path.as_deref().filter(|path| !path.is_empty()) {
            space.path_missing = *checked_paths.entry(path).or_insert_with(|| {
                !std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
            });
        }
    }
    Ok(WorkspaceData { spaces, navigation })
}

fn read_spaces(db: &Connection) -> Result<Vec<Space>> {
    let mut statement = db.prepare_cached(
        "SELECT s.id,s.name,s.path,s.archived,s.parent_id,s.sort_order,s.created_at,
        i.shape,i.color FROM spaces s LEFT JOIN workspace_icons i ON i.workspace_id=s.id
        ORDER BY s.updated_at DESC,s.rowid",
    )?;
    let mut spaces = statement
        .query_map([], |row| {
            Ok(Space {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                archived: row.get(3)?,
                parent_id: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                icon_shape: row.get(7)?,
                icon_color: row.get(8)?,
                effective_archived: false,
                path_missing: false,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let effective = effective_archives(&spaces);
    for (space, archived) in spaces.iter_mut().zip(effective) {
        space.effective_archived = archived.unwrap_or(false);
    }
    Ok(spaces)
}

fn effective_archives(spaces: &[Space]) -> Vec<Option<bool>> {
    let indices = spaces
        .iter()
        .enumerate()
        .map(|(i, space)| (space.id.as_str(), i))
        .collect::<HashMap<_, _>>();
    let mut effective = vec![None; spaces.len()];
    let mut chain = HashSet::new();
    for start in 0..spaces.len() {
        let mut current = start;
        let archived = loop {
            if let Some(archived) = effective[current] {
                break archived;
            }
            if !chain.insert(current) {
                break false;
            }
            let space = &spaces[current];
            if space.archived != 0 {
                break true;
            }
            let Some(parent) = space
                .parent_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .and_then(|id| indices.get(id))
            else {
                break false;
            };
            current = *parent;
        };
        for index in chain.drain() {
            effective[index] = Some(archived);
        }
    }
    effective
}

fn has_generated_spaces(db: &Connection) -> Result<bool> {
    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_workspace_navigation_spaces')", [], |row| row.get(0))?)
}

fn digest(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))[..24].to_owned()
}

fn owner_space(bot_id: &str, team_id: Option<&str>) -> String {
    match team_id.filter(|id| !id.is_empty()) {
        Some(id) => format!("bot-team-space-{}", digest(id)),
        None => format!("bot-space-{}", digest(bot_id)),
    }
}

fn read_history_spaces(db: &Connection, user_id: &str) -> Result<HashSet<String>> {
    let mut statement = db.prepare_cached(&format!(
        "SELECT c.bot_id,c.team_id FROM bot_conversations c WHERE {CONVERSATION_FILTER}
        UNION SELECT r.bot_id,c.team_id {RECEIPTS}"
    ))?;
    let rows = statement.query_map([user_id], |row| {
        let bot_id: String = row.get(0)?;
        let team_id: Option<String> = row.get(1)?;
        Ok(owner_space(&bot_id, team_id.as_deref()))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn read_navigation(db: &Connection, user_id: &str) -> Result<Navigation> {
    let mut requests = db.prepare_cached(&format!(
        "SELECT r.conversation_id,r.bot_id,c.team_id,u.text,u.created_at,
        a.updated_at,c.archived_at,r.request_id,r.assistant_message_id,a.status {RECEIPTS}
        ORDER BY u.created_at DESC,r.request_id"
    ))?;
    let foreground_requests = requests
        .query_map([user_id], |row| {
            let conversation = conversation_row(row, "附件对话")?;
            let request_id: String = row.get(7)?;
            Ok(ForegroundRequest {
                id: format!("bot-request:{}:{request_id}", conversation.bot_id),
                request_id,
                message_id: row.get(8)?,
                status: row.get(9)?,
                conversation,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut conversations = db.prepare_cached(&format!("SELECT c.conversation_id,c.bot_id,c.team_id,
        (SELECT m.text FROM bot_messages m WHERE m.conversation_id=c.conversation_id AND m.role='user' ORDER BY m.ordinal LIMIT 1),
        c.created_at,c.updated_at,c.archived_at FROM bot_conversations c WHERE {CONVERSATION_FILTER}
        ORDER BY c.created_at DESC,c.conversation_id"))?;
    let conversations = conversations
        .query_map([user_id], |row| conversation_row(row, "新对话"))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Navigation {
        foreground_requests,
        conversations,
    })
}

fn conversation_row(row: &rusqlite::Row<'_>, empty_title: &str) -> rusqlite::Result<Conversation> {
    let bot_id: String = row.get(1)?;
    let team_id: Option<String> = row.get(2)?;
    let title: Option<String> = row.get(3)?;
    Ok(Conversation {
        conversation_id: row.get(0)?,
        space_id: owner_space(&bot_id, team_id.as_deref()),
        bot_id,
        team_id,
        title: preview_title(title.as_deref().unwrap_or_default(), empty_title),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        archived: row.get::<_, Option<i64>>(6)?.is_some(),
    })
}

fn preview_title(text: &str, fallback: &str) -> String {
    // Keep JavaScript's whitespace semantics. The host applies the final UTF-16 length limit.
    let is_space = |ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}';
    let mut title = String::new();
    let mut length = 0;
    for word in text.split(is_space).filter(|word| !word.is_empty()) {
        if length != 0 {
            title.push(' ');
            length += 1;
        }
        for ch in word.chars() {
            title.push(ch);
            length += ch.len_utf16();
            if length >= 120 {
                return title;
            }
        }
    }
    if title.is_empty() {
        fallback.to_owned()
    } else {
        title
    }
}

fn generated_child(id: &str) -> bool {
    id.strip_prefix("bot-space-")
        .or_else(|| id.strip_prefix("bot-team-space-"))
        .is_some_and(|suffix| {
            suffix.len() == 24
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn retain_visible(
    db: &Connection,
    user_id: &str,
    history: &HashSet<impl std::borrow::Borrow<str> + Eq + std::hash::Hash>,
    spaces: &mut Vec<Space>,
) -> Result<()> {
    let user = digest(user_id);
    let groups = [
        format!("bot-workspace-group-bot-{user}"),
        format!("bot-workspace-group-team-{user}"),
    ];
    let mut generated =
        db.prepare_cached("SELECT space_id,auto_name FROM bot_workspace_navigation_spaces")?;
    let names = generated
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    let mut used = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM (
        SELECT space_id AS space FROM tasks UNION ALL SELECT space_id FROM cron_jobs
        UNION ALL SELECT default_space_id FROM projects UNION ALL SELECT workspace_id FROM workspace_notes
        UNION ALL SELECT workspace_id FROM library_spaces UNION ALL SELECT workspace_id FROM workspace_library_links
        UNION ALL SELECT workspace_id FROM workspace_library_collection_links
        UNION ALL SELECT scope_id FROM gadgets WHERE scope_type='workspace'
        UNION ALL SELECT scope_id FROM memory_scopes WHERE scope_type='workspace'
        ) WHERE space=? LIMIT 1)")?;
    let mut eligible = |space: &Space| -> rusqlite::Result<bool> {
        Ok(space.path.as_deref().unwrap_or_default().is_empty()
            && names.get(&space.id) == Some(&space.name)
            && !history.contains(space.id.as_str())
            && !used.query_row([&space.id], |row| row.get::<_, bool>(0))?)
    };
    let mut children = HashMap::<&str, Vec<&str>>::new();
    for space in spaces.iter() {
        if let Some(parent) = &space.parent_id {
            children.entry(parent).or_default().push(&space.id);
        }
    }
    let mut hidden = HashSet::new();
    for space in spaces.iter() {
        let in_group = space
            .parent_id
            .as_ref()
            .is_some_and(|parent| groups.contains(parent));
        if in_group
            && generated_child(&space.id)
            && !children.contains_key(space.id.as_str())
            && eligible(space)?
        {
            hidden.insert(space.id.clone());
        }
    }
    for space in spaces.iter() {
        if groups.contains(&space.id)
            && space.parent_id.as_deref().unwrap_or_default().is_empty()
            && children
                .get(space.id.as_str())
                .is_none_or(|ids| ids.iter().all(|id| hidden.contains(*id)))
            && eligible(space)?
        {
            hidden.insert(space.id.clone());
        }
    }
    spaces.retain(|space| !hidden.contains(&space.id));
    Ok(())
}
