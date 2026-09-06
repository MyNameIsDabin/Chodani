//! A tiny loopback HTTP server that feeds the <video> element.
//!
//! Two reasons this exists instead of pointing <video> straight at the file:
//!   1. Byte-range support, so the media element can seek freely.
//!   2. Everything (local file or remote YouTube stream) is served from one
//!      origin with permissive CORS, so `crossorigin="anonymous"` holds and the
//!      canvas stays untainted — onion skin and PNG export depend on that.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::OnceLock;

use rand::Rng;
use tiny_http::{Header, Request, Response, Server, StatusCode};

pub struct MediaServer {
    pub port: u16,
    pub token: String,
}

static SERVER: OnceLock<MediaServer> = OnceLock::new();

pub fn info() -> &'static MediaServer {
    SERVER.get().expect("media server not started")
}

pub fn start() -> Result<(), String> {
    if SERVER.get().is_some() {
        return Ok(());
    }
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("로컬 서버 시작 실패: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("로컬 서버 포트를 알 수 없습니다")?
        .port();

    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let token: String = {
        let mut rng = rand::thread_rng();
        (0..32)
            .map(|_| char::from(ALPHABET[rng.gen_range(0..ALPHABET.len())]))
            .collect()
    };
    let expected = token.clone();

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let expected = expected.clone();
            // One thread per request: the media element holds a connection open
            // for the streaming read while it also fires off range requests.
            std::thread::spawn(move || {
                if let Err(e) = handle(request, &expected) {
                    eprintln!("media server: {e}");
                }
            });
        }
    });

    let _ = SERVER.set(MediaServer { port, token });
    Ok(())
}

/// URL the WebView (or ffprobe) should hit to read `src` through this server.
pub fn local_url(kind: &str, src: &str) -> String {
    let i = info();
    format!(
        "http://127.0.0.1:{}/media?t={}&kind={}&src={}",
        i.port,
        i.token,
        kind,
        urlencoding::encode(src)
    )
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn cors_headers() -> Vec<Header> {
    vec![
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
        header("Access-Control-Allow-Headers", "Range, Content-Type"),
        header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Range, Accept-Ranges",
        ),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
    ]
}

fn query_params(url: &str) -> Vec<(String, String)> {
    let Some(q) = url.split_once('?').map(|(_, rest)| rest) else {
        return Vec::new();
    };
    q.split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((
                urlencoding::decode(k).ok()?.into_owned(),
                urlencoding::decode(v).ok()?.into_owned(),
            ))
        })
        .collect()
}

fn param(params: &[(String, String)], key: &str) -> Option<String> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
}

/// Parse `bytes=<start>-<end?>`. Suffix ranges (`bytes=-500`) are not emitted by
/// media elements, so anything we cannot read is served as a full response.
fn parse_range(raw: &str, len: u64) -> Option<(u64, u64)> {
    let spec = raw.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    if s.is_empty() {
        return None;
    }
    let start: u64 = s.trim().parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if e.trim().is_empty() {
        len - 1
    } else {
        e.trim().parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn respond_empty(request: Request, code: u16, extra: Vec<Header>) -> Result<(), String> {
    let mut resp = Response::empty(StatusCode(code));
    for h in cors_headers().into_iter().chain(extra) {
        resp.add_header(h);
    }
    request.respond(resp).map_err(|e| e.to_string())
}

fn handle(request: Request, expected_token: &str) -> Result<(), String> {
    let url = request.url().to_string();
    let params = query_params(&url);

    if request.method().as_str() == "OPTIONS" {
        return respond_empty(request, 204, vec![]);
    }
    if param(&params, "t").as_deref() != Some(expected_token) {
        return respond_empty(request, 403, vec![]);
    }

    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let Some(src) = param(&params, "src") else {
        return respond_empty(request, 400, vec![]);
    };

    if param(&params, "kind").as_deref() == Some("url") {
        serve_remote(request, &src, range.as_deref())
    } else {
        serve_file(request, &src, range.as_deref())
    }
}

fn guess_mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "m4a" => "audio/mp4",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn serve_file(request: Request, path: &str, range: Option<&str>) -> Result<(), String> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return respond_empty(request, 404, vec![]),
    };
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut headers = cors_headers();
    headers.push(header("Content-Type", guess_mime(path)));

    match range.and_then(|r| parse_range(r, len)) {
        Some((start, end)) => {
            let count = end - start + 1;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            headers.push(header(
                "Content-Range",
                &format!("bytes {start}-{end}/{len}"),
            ));
            let resp = Response::new(
                StatusCode(206),
                headers,
                file.take(count),
                Some(count as usize),
                None,
            );
            request.respond(resp).map_err(|e| e.to_string())
        }
        None => {
            let resp = Response::new(StatusCode(200), headers, file, Some(len as usize), None);
            request.respond(resp).map_err(|e| e.to_string())
        }
    }
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fn serve_remote(request: Request, url: &str, range: Option<&str>) -> Result<(), String> {
    let mut req = ureq::get(url).set("User-Agent", UA);
    if let Some(r) = range {
        req = req.set("Range", r);
    }
    let upstream = match req.call() {
        Ok(r) => r,
        // ureq turns 4xx/5xx into Err(Status); mirror the code back to the player.
        Err(ureq::Error::Status(code, _)) => return respond_empty(request, code, vec![]),
        Err(e) => {
            eprintln!("upstream fetch failed: {e}");
            return respond_empty(request, 502, vec![]);
        }
    };

    let status = upstream.status();
    let mut headers = cors_headers();
    for name in ["Content-Type", "Content-Range"] {
        if let Some(v) = upstream.header(&name.to_lowercase()) {
            headers.push(header(name, v));
        }
    }
    let len: Option<usize> = upstream
        .header("content-length")
        .and_then(|v| v.parse().ok());

    let resp = Response::new(StatusCode(status), headers, upstream.into_reader(), len, None);
    request.respond(resp).map_err(|e| e.to_string())
}
