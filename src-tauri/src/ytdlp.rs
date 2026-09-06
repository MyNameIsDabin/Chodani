//! YouTube (and any other yt-dlp supported site) support.
//!
//! yt-dlp only resolves the link to a direct media URL; playback and frame
//! stepping then run through the same path as a local file, so frame accuracy
//! is identical. Nothing is written to disk unless `download` is used.

use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use crate::proc;

const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

#[derive(Debug, Clone, Serialize)]
pub struct Resolved {
    pub url: String,
    pub title: String,
    pub has_audio: bool,
}

pub fn available() -> bool {
    proc::tool_available("yt-dlp", "--version")
}

/// Fetch yt-dlp.exe into the app's own bin directory. Only ever called from an
/// explicit user action — nothing downloads itself in the background.
pub fn install() -> Result<String, String> {
    if !cfg!(windows) {
        return Err("자동 설치는 Windows에서만 지원됩니다. 패키지 매니저로 yt-dlp를 설치해 주세요.".into());
    }
    let bin = proc::app_dir().join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let dst = bin.join("yt-dlp.exe");

    let resp = ureq::get(RELEASE_URL)
        .call()
        .map_err(|e| format!("yt-dlp 다운로드 실패: {e}"))?;
    let mut reader = resp.into_reader();
    let tmp = dst.with_extension("part");
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| format!("파일 생성 실패: {e}"))?;
        std::io::copy(&mut reader, &mut file).map_err(|e| format!("다운로드 중 오류: {e}"))?;
        file.flush().ok();
    }
    std::fs::rename(&tmp, &dst).map_err(|e| format!("설치 실패: {e}"))?;
    Ok(dst.to_string_lossy().into_owned())
}

/// `quality` picks the trade-off the UI offers:
///   "video" — best video-only stream (high resolution, no sound)
///   "muxed" — best single file that already carries audio (lower resolution)
fn selector(quality: &str, max_height: u32) -> String {
    match quality {
        "muxed" => format!("b[ext=mp4][height<=?{max_height}]/b[height<=?{max_height}]/b"),
        _ => format!(
            "bv*[ext=mp4][height<=?{max_height}]/bv*[height<=?{max_height}]/b[height<=?{max_height}]/b"
        ),
    }
}

fn run_json(args: &[String]) -> Result<Value, String> {
    let out = proc::output(&proc::tool("yt-dlp"), args)?;
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or("yt-dlp가 정보를 반환하지 않았습니다")?;
    serde_json::from_str(line).map_err(|e| format!("yt-dlp 출력 해석 실패: {e}"))
}

pub fn resolve(url: &str, quality: &str, max_height: u32) -> Result<Resolved, String> {
    if !available() {
        return Err("yt-dlp가 설치되어 있지 않습니다.".into());
    }
    let args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "-f".into(),
        selector(quality, max_height),
        "-J".into(),
        url.into(),
    ];
    let info = run_json(&args)?;

    // A muxed pick lands in `url`; a video+audio pick lands in requested_formats.
    let fmt = info
        .get("requested_formats")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or_else(|| info.clone());

    let media_url = fmt
        .get("url")
        .and_then(Value::as_str)
        .ok_or("재생 가능한 스트림 주소를 찾지 못했습니다")?
        .to_string();
    let title = info
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("YouTube")
        .to_string();
    let has_audio = fmt
        .get("acodec")
        .and_then(Value::as_str)
        .map(|c| c != "none")
        .unwrap_or(false);

    Ok(Resolved {
        url: media_url,
        title,
        has_audio,
    })
}

/// Download and mux to a cached MP4 — the reliable option when a stream URL
/// expires mid-session or the site refuses ranged playback.
pub fn download(url: &str, max_height: u32) -> Result<PathBuf, String> {
    if !available() {
        return Err("yt-dlp가 설치되어 있지 않습니다.".into());
    }
    let dir = proc::cache_dir().join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let template = dir.join("%(id)s.%(ext)s");

    let args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "-f".into(),
        format!("bv*[height<=?{max_height}]+ba/b[height<=?{max_height}]/b"),
        "--merge-output-format".into(),
        "mp4".into(),
        "--print".into(),
        "after_move:filepath".into(),
        "-o".into(),
        template.to_string_lossy().into_owned(),
        url.into(),
    ];
    let out = proc::output(&proc::tool("yt-dlp"), &args)?;
    let path = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back()
        .ok_or("다운로드된 파일 경로를 알 수 없습니다")?;
    Ok(PathBuf::from(path))
}
