//! Child-process helpers. On Windows every spawn must suppress the console
//! window, otherwise a black cmd flashes on every ffprobe call.

use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run a program and return stdout as UTF-8, or an error carrying stderr.
pub fn output(program: &str, args: &[String]) -> Result<String, String> {
    let out = command(program)
        .args(args)
        .output()
        .map_err(|e| format!("'{program}' 실행 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(6).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        return Err(format!("'{program}' 오류: {}", tail.join("\n")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn app_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Chodani")
}

pub fn cache_dir() -> PathBuf {
    let d = app_dir().join("cache");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Locate a tool: prefer one we downloaded into the app dir, else fall back to PATH.
pub fn tool(name: &str) -> String {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let local = app_dir().join("bin").join(&exe);
    if local.exists() {
        return local.to_string_lossy().into_owned();
    }
    name.to_string()
}

pub fn tool_available(name: &str, version_flag: &str) -> bool {
    command(&tool(name))
        .arg(version_flag)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
