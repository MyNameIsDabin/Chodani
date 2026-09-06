//! Everything that talks to ffmpeg/ffprobe: probing, frame-timestamp indexing,
//! and transcoding sources the WebView cannot play natively (GIF, MKV, ProRes…).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::proc;

/// Containers/codecs WebView2 plays without help. Anything else gets transcoded
/// into the cache once, so stepping stays frame-exact afterwards.
const WEB_SAFE_CODECS: &[&str] = &["h264", "vp8", "vp9", "av1"];
const WEB_SAFE_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    /// "file" or "url" — how the media server should fetch it.
    pub kind: String,
    /// What the media server reads from (a path on disk, or a remote URL).
    pub serve: String,
    /// What the user originally opened; the key notes are stored under.
    pub origin: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    /// Nominal frame rate (from r_frame_rate), used when no index is built.
    pub fps: f64,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Frame count: exact when ffprobe reports it, otherwise duration * fps.
    pub frame_count: u64,
    pub frame_count_exact: bool,
    /// r_frame_rate disagrees with avg_frame_rate → timestamps are uneven, so an
    /// index scan is needed for exact frame numbers.
    pub variable_frame_rate: bool,
    pub has_audio: bool,
    pub codec: String,
    /// True when we transcoded into the cache rather than serving the original.
    pub transcoded: bool,
}

fn ffprobe_json(src: &str, remote: bool) -> Result<Value, String> {
    let mut args: Vec<String> = ["-v", "error", "-print_format", "json"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if remote {
        // Streams arrive over the network: let ffprobe read further before it
        // gives up on working out the frame rate.
        args.extend(
            ["-probesize", "20M", "-analyzeduration", "10M"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    args.extend(
        ["-show_streams", "-show_format", src]
            .iter()
            .map(|s| s.to_string()),
    );
    let out = proc::output(&proc::tool("ffprobe"), &args)?;
    serde_json::from_str(&out).map_err(|e| format!("ffprobe 출력 해석 실패: {e}"))
}

/// What ffprobe/ffmpeg should read. Remote sources go through the local server
/// so they pick up the browser User-Agent the CDN expects.
pub fn probe_target(kind: &str, serve: &str) -> String {
    if kind == "url" {
        crate::server::local_url(kind, serve)
    } else {
        serve.to_string()
    }
}

/// Parse an ffprobe rational like "24000/1001".
fn parse_rational(s: &str) -> Option<(u32, u32)> {
    let (n, d) = s.split_once('/')?;
    let n: u32 = n.parse().ok()?;
    let d: u32 = d.parse().ok()?;
    if n == 0 || d == 0 {
        return None;
    }
    Some((n, d))
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn num_field(v: &Value, key: &str) -> Option<f64> {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

pub fn probe(kind: &str, serve: &str, origin: &str) -> Result<MediaInfo, String> {
    let root = ffprobe_json(&probe_target(kind, serve), kind == "url")?;
    let streams = root
        .get("streams")
        .and_then(Value::as_array)
        .ok_or("영상 스트림 정보를 읽지 못했습니다")?;

    let video = streams
        .iter()
        .find(|s| str_field(s, "codec_type") == "video")
        .ok_or("영상 스트림이 없습니다")?;
    let has_audio = streams
        .iter()
        .any(|s| str_field(s, "codec_type") == "audio");

    let (fps_num, fps_den) = parse_rational(&str_field(video, "r_frame_rate"))
        .or_else(|| parse_rational(&str_field(video, "avg_frame_rate")))
        .unwrap_or((25, 1));
    let fps = fps_num as f64 / fps_den as f64;

    let avg = parse_rational(&str_field(video, "avg_frame_rate"));
    // A ~0.5% gap is just rounding between 30000/1001 style rationals.
    let variable_frame_rate = match avg {
        Some((an, ad)) => {
            let avg_fps = an as f64 / ad as f64;
            (avg_fps - fps).abs() / fps.max(1e-9) > 0.005
        }
        None => true,
    };

    let duration = num_field(video, "duration")
        .or_else(|| root.get("format").and_then(|f| num_field(f, "duration")))
        .unwrap_or(0.0);

    let exact = num_field(video, "nb_frames")
        .filter(|n| *n > 0.0)
        .map(|n| n as u64);
    let (frame_count, frame_count_exact) = match exact {
        Some(n) => (n, true),
        None => (((duration * fps).round() as i64).max(0) as u64, false),
    };

    let title = if kind == "url" {
        origin.to_string()
    } else {
        Path::new(origin)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| origin.to_string())
    };

    Ok(MediaInfo {
        kind: kind.to_string(),
        serve: serve.to_string(),
        origin: origin.to_string(),
        title,
        width: num_field(video, "width").unwrap_or(0.0) as u32,
        height: num_field(video, "height").unwrap_or(0.0) as u32,
        duration,
        fps,
        fps_num,
        fps_den,
        frame_count,
        frame_count_exact,
        variable_frame_rate,
        has_audio,
        codec: str_field(video, "codec_name"),
        transcoded: false,
    })
}

/// Exact presentation timestamp of every video frame, ascending.
///
/// Packets are read rather than decoded frames: a packet's `pts_time` is already
/// the presentation time, so this is the same answer an order of magnitude
/// faster. Containers that carry only DTS fall back to a real decode pass.
pub fn frame_index(kind: &str, serve: &str) -> Result<Vec<f64>, String> {
    let src = probe_target(kind, serve);
    let mut times = probe_timestamps(&src, "packet=pts_time")?;
    if times.len() < 2 {
        times = probe_timestamps(&src, "frame=best_effort_timestamp_time")?;
    }
    if times.is_empty() {
        return Err("프레임 타임스탬프를 읽지 못했습니다".into());
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup();

    // The player's timeline starts at zero; ffprobe timestamps may not.
    let origin = times[0];
    if origin != 0.0 {
        for t in times.iter_mut() {
            *t -= origin;
        }
    }
    Ok(times)
}

fn probe_timestamps(src: &str, entries: &str) -> Result<Vec<f64>, String> {
    let args: Vec<String> = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        entries,
        "-of",
        "csv=p=0",
        src,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let out = proc::output(&proc::tool("ffprobe"), &args)?;
    Ok(out
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').parse::<f64>().ok())
        .filter(|t| t.is_finite())
        .collect())
}

fn cache_key(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    if let Ok(meta) = std::fs::metadata(path) {
        hasher.update(meta.len().to_le_bytes());
        if let Ok(t) = meta.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(d.as_secs().to_le_bytes());
            }
        }
    }
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn needs_transcode(path: &Path, info: &MediaInfo) -> bool {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    !WEB_SAFE_EXTS.contains(&ext.as_str()) || !WEB_SAFE_CODECS.contains(&info.codec.as_str())
}

/// Open a local file, transcoding into the cache when the WebView cannot decode
/// it. GIFs always go through this path — they are otherwise unseekable.
pub fn prepare_local(app: &AppHandle, path: &str) -> Result<MediaInfo, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("파일을 찾을 수 없습니다: {path}"));
    }
    let info = probe("file", path, path)?;
    if !needs_transcode(&p, &info) {
        return Ok(info);
    }

    let out = proc::cache_dir().join(format!("{}.mp4", cache_key(&p)));
    if !out.exists() {
        transcode(app, path, &out, info.duration, info.has_audio)?;
    }
    let mut converted = probe("file", &out.to_string_lossy(), path)?;
    converted.title = info.title;
    converted.transcoded = true;
    Ok(converted)
}

/// Re-encode to seekable H.264/MP4, preserving the original frame timings
/// (`-fps_mode passthrough`) so frame numbers keep matching the source.
fn transcode(
    app: &AppHandle,
    src: &str,
    dst: &Path,
    duration: f64,
    with_audio: bool,
) -> Result<(), String> {
    let tmp = dst.with_extension("part.mp4");
    let mut args: Vec<String> = vec![
        "-hide_banner", "-nostdin", "-y",
        "-i", src,
        "-map", "0:v:0",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "14",
        "-pix_fmt", "yuv420p",
        "-fps_mode", "passthrough",
        // H.264 requires even dimensions; GIFs frequently are not.
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-movflags", "+faststart",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if with_audio {
        args.extend(["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k"].iter().map(|s| s.to_string()));
    } else {
        args.push("-an".into());
    }
    args.extend(["-progress", "pipe:1"].iter().map(|s| s.to_string()));
    args.push(tmp.to_string_lossy().into_owned());

    let mut child = proc::command(&proc::tool("ffmpeg"))
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok())
            else {
                continue;
            };
            let ratio = if duration > 0.0 {
                (us / 1e6 / duration).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let _ = app.emit("convert-progress", ratio);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut err);
        }
        let _ = std::fs::remove_file(&tmp);
        let tail: Vec<&str> = err.lines().rev().take(5).collect();
        return Err(format!(
            "변환 실패: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        ));
    }
    std::fs::rename(&tmp, dst).map_err(|e| format!("변환 결과 저장 실패: {e}"))?;
    let _ = app.emit("convert-progress", 1.0);
    Ok(())
}
