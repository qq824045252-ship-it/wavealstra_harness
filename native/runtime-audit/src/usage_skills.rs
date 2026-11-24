use crate::javascript_whitespace;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
};

#[derive(Serialize)]
pub struct SkillCount {
    name: String,
    count: usize,
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn skill_name(line: &str) -> Option<&str> {
    let text = line.trim_start_matches(javascript_whitespace);
    let body = text.strip_prefix(['/', '$'])?;
    let bytes = body.as_bytes();
    if !bytes.first()?.is_ascii_alphabetic() {
        return None;
    }
    let end = bytes
        .iter()
        .take(65)
        .take_while(|&&b| word(b) || b == b'.' || b == b'-')
        .count();
    // Match the ASCII word boundary after the longest possible name.
    let last = (2..=end)
        .rev()
        .find(|&i| word(bytes[i - 1]) != bytes.get(i).is_some_and(|&b| word(b)))?;
    (last <= 64).then(|| &body[..last])
}

fn count_text(text: &str, counts: &mut HashMap<String, usize>) {
    for line in text.split('\n') {
        if let Some(name) = skill_name(line) {
            *counts.entry(name.to_ascii_lowercase()).or_insert(0) += 1;
        }
    }
}

fn count_entry(entry: Value, counts: &mut HashMap<String, usize>) {
    if entry["type"] != "message" || entry["message"]["role"] != "user" {
        return;
    }
    let content = &entry["message"]["content"];
    if let Some(text) = content.as_str() {
        count_text(text, counts);
    } else if let Some(blocks) = content.as_array() {
        for block in blocks {
            if let Some(text) = block
                .as_str()
                .or_else(|| block["text"].as_str())
                .or_else(|| block["content"].as_str())
            {
                count_text(text, counts);
            }
        }
    }
}

fn parse_entry(line: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(line);
    if let Ok(entry) = serde_json::from_str(&text) {
        return Some(entry);
    }
    // JavaScript accepts escaped lone UTF-16 units. They cannot form part of an ASCII skill name.
    let bytes = text.as_bytes();
    let mut repaired = String::new();
    let mut cursor = 0;
    let mut copied = 0;
    while let Some(offset) = text[cursor..].find('\\') {
        let start = cursor + offset;
        let unit = bytes.get(start..start + 6);
        if unit.is_some_and(|unit| {
            unit[1] == b'u'
                && unit[2].eq_ignore_ascii_case(&b'd')
                && matches!(unit[3].to_ascii_lowercase(), b'8'..=b'9' | b'a'..=b'f')
                && unit[4..].iter().all(u8::is_ascii_hexdigit)
        }) {
            repaired.push_str(&text[copied..start]);
            repaired.push_str("\\ufffd");
            cursor = start + 6;
            copied = cursor;
        } else {
            cursor = start + 1 + usize::from(bytes.get(start + 1) == Some(&b'\\'));
        }
    }
    if copied == 0 {
        return None;
    }
    repaired.push_str(&text[copied..]);
    serde_json::from_str(&repaired).ok()
}

pub fn counts(files: HashSet<String>) -> Vec<SkillCount> {
    let mut counts = HashMap::new();
    for path in files {
        if !std::fs::metadata(&path).is_ok_and(|info| info.is_file()) {
            continue;
        }
        let Ok(file) = File::open(path) else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        let mut file_counts = HashMap::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(entry) = parse_entry(&line) {
                        count_entry(entry, &mut file_counts);
                    }
                }
                // The host skips the entire file when its read fails.
                Err(_) => {
                    file_counts.clear();
                    break;
                }
            }
        }
        for (name, count) in file_counts {
            *counts.entry(name).or_insert(0) += count;
        }
    }
    let mut counts: Vec<_> = counts
        .into_iter()
        .map(|(name, count)| SkillCount { name, count })
        .collect();
    counts.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.count));
    // Electron orders the final ties using the same locale collation as before.
    if let Some(threshold) = counts.get(19).map(|entry| entry.count) {
        counts.retain(|entry| entry.count >= threshold);
    }
    counts
}
