mod media;
mod proc;
mod server;
mod store;
mod ytdlp;

use std::path::PathBuf;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Serialize)]
struct ToolStatus {
    ffmpeg: bool,
    ffprobe: bool,
    ytdlp: bool,
    cache_dir: String,
}

#[tauri::command]
fn tool_status() -> ToolStatus {
    ToolStatus {
        ffmpeg: proc::tool_available("ffmpeg", "-version"),
        ffprobe: proc::tool_available("ffprobe", "-version"),
        ytdlp: ytdlp::available(),
        cache_dir: proc::cache_dir().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
fn install_ytdlp() -> Result<String, String> {
    ytdlp::install()
}

/// URL the <video> element should load for an already-opened source.
#[tauri::command]
fn playback_url(kind: String, serve: String) -> String {
    server::local_url(&kind, &serve)
}

#[tauri::command]
fn open_local(app: AppHandle, path: String) -> Result<media::MediaInfo, String> {
    media::prepare_local(&app, &path)
}

#[tauri::command]
fn open_stream(url: String, quality: String, max_height: u32) -> Result<media::MediaInfo, String> {
    let resolved = ytdlp::resolve(&url, &quality, max_height)?;
    let mut info = media::probe("url", &resolved.url, &url)?;
    info.title = resolved.title;
    info.has_audio = resolved.has_audio && info.has_audio;
    Ok(info)
}

/// Fall-back path for links whose stream URL will not play directly.
#[tauri::command]
fn download_stream(
    app: AppHandle,
    url: String,
    max_height: u32,
) -> Result<media::MediaInfo, String> {
    let path = ytdlp::download(&url, max_height)?;
    let mut info = media::prepare_local(&app, &path.to_string_lossy())?;
    info.origin = url;
    Ok(info)
}

/// Exact presentation time of every frame. Slow for remote sources (the whole
/// stream has to be read), so the UI only asks for it on demand there.
#[tauri::command]
fn frame_index(kind: String, serve: String) -> Result<Vec<f64>, String> {
    media::frame_index(&kind, &serve)
}

#[tauri::command]
fn save_project(origin: String, title: String, kind: String, data: Value) -> Result<(), String> {
    store::save(&origin, &title, &kind, data)
}

#[tauri::command]
fn load_project(origin: String) -> Result<Option<Value>, String> {
    store::load(&origin)
}

#[tauri::command]
fn recent_projects() -> Vec<store::RecentEntry> {
    store::recent()
}

#[tauri::command]
fn forget_project(origin: String) -> Result<(), String> {
    store::forget(&origin)
}

#[tauri::command]
fn export_project(path: String, data: Value) -> Result<(), String> {
    store::write_json(&PathBuf::from(path), &data)
}

#[tauri::command]
fn import_project(path: String) -> Result<Value, String> {
    store::read_json(&PathBuf::from(path))
}

/// Write a canvas snapshot. `data_url` is what `canvas.toDataURL()` produced.
#[tauri::command]
fn save_image(path: String, data_url: String) -> Result<(), String> {
    let payload = data_url
        .split_once(",")
        .map(|(_, b)| b)
        .ok_or("이미지 데이터 형식이 올바르지 않습니다")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("이미지 디코딩 실패: {e}"))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&p, bytes).map_err(|e| format!("이미지 저장 실패: {e}"))
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if p.is_file() {
        p.parent().map(PathBuf::from).unwrap_or(p.clone())
    } else {
        p.clone()
    };
    #[cfg(windows)]
    {
        proc::command("explorer")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("탐색기 열기 실패: {e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("이 플랫폼에서는 지원되지 않습니다".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    server::start().expect("failed to start the local media server");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            tool_status,
            install_ytdlp,
            playback_url,
            open_local,
            open_stream,
            download_stream,
            frame_index,
            save_project,
            load_project,
            recent_projects,
            forget_project,
            export_project,
            import_project,
            save_image,
            reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chodani");
}
