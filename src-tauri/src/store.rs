//! Per-source persistence for markers, notes and loop points.
//!
//! The payload is kept as opaque JSON: the player owns the marker schema, and
//! this layer only decides where it lives and keeps a "recent" index in sync.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::proc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub origin: String,
    pub title: String,
    pub kind: String,
    pub updated: u64,
    pub marker_count: usize,
}

fn projects_dir() -> PathBuf {
    let d = proc::app_dir().join("projects");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn key(origin: &str) -> String {
    let mut h = Sha256::new();
    h.update(origin.as_bytes());
    format!("{:x}", h.finalize())[..20].to_string()
}

fn project_path(origin: &str) -> PathBuf {
    projects_dir().join(format!("{}.json", key(origin)))
}

fn recent_path() -> PathBuf {
    proc::app_dir().join("recent.json")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn save(origin: &str, title: &str, kind: &str, data: Value) -> Result<(), String> {
    let marker_count = data
        .get("markers")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);

    let mut doc = data;
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("origin".into(), json!(origin));
        obj.insert("title".into(), json!(title));
        obj.insert("kind".into(), json!(kind));
        obj.insert("updated".into(), json!(now()));
    }
    write_json(&project_path(origin), &doc)?;
    touch_recent(origin, title, kind, marker_count)
}

pub fn load(origin: &str) -> Result<Option<Value>, String> {
    let path = project_path(origin);
    if !path.exists() {
        return Ok(None);
    }
    read_json(&path).map(Some)
}

pub fn recent() -> Vec<RecentEntry> {
    read_json(&recent_path())
        .ok()
        .and_then(|v| serde_json::from_value::<Vec<RecentEntry>>(v).ok())
        .unwrap_or_default()
}

pub fn forget(origin: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(project_path(origin));
    let list: Vec<RecentEntry> = recent().into_iter().filter(|e| e.origin != origin).collect();
    write_json(&recent_path(), &json!(list))
}

fn touch_recent(origin: &str, title: &str, kind: &str, marker_count: usize) -> Result<(), String> {
    let mut list: Vec<RecentEntry> = recent()
        .into_iter()
        .filter(|e| e.origin != origin)
        .collect();
    list.insert(
        0,
        RecentEntry {
            origin: origin.to_string(),
            title: title.to_string(),
            kind: kind.to_string(),
            updated: now(),
            marker_count,
        },
    );
    list.truncate(40);
    write_json(&recent_path(), &json!(list))
}

pub fn read_json(path: &PathBuf) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("읽기 실패: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("JSON 해석 실패: {e}"))
}

pub fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("쓰기 실패: {e}"))
}
