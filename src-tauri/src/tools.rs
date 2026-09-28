//! Fetching the external binaries Chodani shells out to.
//!
//! Everything lands in the app's own `bin` directory rather than on PATH: an
//! app that needs a decoder should not be editing the user's system to get one,
//! and `proc::tool` already prefers this directory over whatever is installed
//! globally. Uninstalling the app takes these with it.

use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::proc;

/// Static Windows build. The plain filename is a permanent redirect to the
/// current release, so it does not need bumping as ffmpeg versions move.
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const YTDLP_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

#[derive(Clone, Serialize)]
struct Progress {
    label: String,
    /// 0.0–1.0, or -1 when the server did not say how big the download is.
    ratio: f64,
}

pub fn bin_dir() -> Result<PathBuf, String> {
    let dir = proc::app_dir().join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    Ok(dir)
}

/// Stream `url` to `dst`, reporting progress as it goes.
///
/// Written to a `.part` file and renamed at the end so an interrupted download
/// can never be mistaken for a finished one.
fn download(app: &AppHandle, url: &str, dst: &PathBuf, label: &str) -> Result<(), String> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| format!("{label} 다운로드 실패: {e}"))?;
    let total: u64 = resp
        .header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let part = dst.with_extension("part");
    let mut out = File::create(&part).map_err(|e| format!("파일 생성 실패: {e}"))?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last_sent: u64 = 0;

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("{label} 다운로드 중 오류: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("쓰기 실패: {e}"))?;
        done += n as u64;

        // Roughly 200 updates over the whole file; any more is just IPC noise.
        let step = (total / 200).max(1 << 20);
        if done - last_sent >= step {
            last_sent = done;
            let ratio = if total > 0 { done as f64 / total as f64 } else { -1.0 };
            let _ = app.emit(
                "tool-progress",
                Progress { label: label.to_string(), ratio },
            );
        }
    }
    out.flush().ok();
    drop(out);

    std::fs::rename(&part, dst).map_err(|e| format!("파일 저장 실패: {e}"))?;
    let _ = app.emit(
        "tool-progress",
        Progress { label: label.to_string(), ratio: 1.0 },
    );
    Ok(())
}

/// Download the ffmpeg build and keep only the two binaries that get used.
///
/// The archive also carries ffplay and documentation; unpacking those would
/// roughly double what ends up on disk for no benefit.
pub fn install_ffmpeg(app: &AppHandle) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("자동 설치는 Windows에서만 지원됩니다. 패키지 매니저로 ffmpeg를 설치해 주세요.".into());
    }
    let bin = bin_dir()?;
    let archive_path = proc::cache_dir().join("ffmpeg-download.zip");
    download(app, FFMPEG_URL, &archive_path, "ffmpeg")?;

    let _ = app.emit(
        "tool-progress",
        Progress { label: "ffmpeg 압축 해제".into(), ratio: -1.0 },
    );

    let file = File::open(&archive_path).map_err(|e| format!("압축 파일 열기 실패: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("압축 파일이 손상되었습니다: {e}"))?;

    let wanted = ["ffmpeg.exe", "ffprobe.exe"];
    let mut extracted = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("압축 해제 실패: {e}"))?;
        let name = entry
            .name()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !wanted.contains(&name.as_str()) {
            continue;
        }
        let dst = bin.join(&name);
        let mut out = File::create(&dst).map_err(|e| format!("{name} 저장 실패: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("{name} 쓰기 실패: {e}"))?;
        extracted += 1;
    }
    let _ = std::fs::remove_file(&archive_path);

    if extracted < wanted.len() {
        return Err("압축 파일에서 ffmpeg/ffprobe를 찾지 못했습니다.".into());
    }
    Ok(bin.to_string_lossy().into_owned())
}

pub fn install_ytdlp(app: &AppHandle) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("자동 설치는 Windows에서만 지원됩니다. 패키지 매니저로 yt-dlp를 설치해 주세요.".into());
    }
    let dst = bin_dir()?.join("yt-dlp.exe");
    download(app, YTDLP_URL, &dst, "yt-dlp")?;
    Ok(dst.to_string_lossy().into_owned())
}
