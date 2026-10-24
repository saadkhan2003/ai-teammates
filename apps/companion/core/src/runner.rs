use std::{path::{Path, PathBuf}, time::Instant};
use tokio::{io::{AsyncRead, AsyncReadExt}, process::Command};

pub const OUTPUT_LIMIT: usize = 65_536;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult { pub exit_code: i32, pub stdout: String, pub stderr: String, pub truncated: bool, pub duration_ms: u64, pub timed_out: bool }
struct ProcessTreeGuard(u32);
impl Drop for ProcessTreeGuard { fn drop(&mut self) { #[cfg(unix)] unsafe { libc::kill(-(self.0 as i32), libc::SIGKILL); } } }

async fn capped<R: AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut out = Vec::new(); let mut buf = [0u8; 8192]; let mut truncated = false;
    loop { match reader.read(&mut buf).await { Ok(0) | Err(_) => break, Ok(n) => { let keep = (OUTPUT_LIMIT - out.len()).min(n); out.extend_from_slice(&buf[..keep]); if keep < n { truncated=true; } } } }
    (out,truncated)
}

pub async fn run(command: &str, cwd: &Path, timeout_sec: u64) -> std::io::Result<RunResult> {
    if !cwd.is_absolute() || !cwd.is_dir() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "cwd must be an absolute existing directory")); }
    #[cfg(unix)] let mut child_cmd = { let mut c=Command::new("sh"); c.arg("-c").arg(command); c };
    #[cfg(windows)] let mut child_cmd = { let mut c=Command::new("cmd"); c.args(["/C", command]); c };
    #[cfg(unix)] use std::os::unix::process::CommandExt;
    child_cmd.current_dir(cwd).env_clear().stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    for name in ["PATH", "HOME", "USER", "LANG", "TEMP", "TMP", "SystemRoot"] { if let Some(value)=std::env::var_os(name) { child_cmd.env(name,value); } }
    #[cfg(unix)] unsafe { child_cmd.as_std_mut().pre_exec(|| { if libc::setpgid(0,0) == -1 { return Err(std::io::Error::last_os_error()); } Ok(()) }); }
    let start=Instant::now(); let mut child=child_cmd.spawn()?; let pid=child.id().unwrap_or_default(); let _tree_guard=ProcessTreeGuard(pid);
    let stdout=child.stdout.take().expect("piped stdout"); let stderr=child.stderr.take().expect("piped stderr");
    let out_task=tokio::spawn(capped(stdout)); let err_task=tokio::spawn(capped(stderr));
    let timeout=tokio::time::Duration::from_secs(timeout_sec.clamp(1,600));
    let status=tokio::time::timeout(timeout, child.wait()).await;
    let timed_out=status.is_err();
    let status=match status { Ok(result)=>result?, Err(_)=>{
        #[cfg(unix)] unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
        #[cfg(windows)] { let _=Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status().await; }
        let _=child.kill().await; child.wait().await?
    }};
    let (out,out_truncated)=out_task.await.unwrap_or_default(); let (err,err_truncated)=err_task.await.unwrap_or_default();
    Ok(RunResult { exit_code: status.code().unwrap_or(-1), stdout:String::from_utf8_lossy(&out).into_owned(), stderr:String::from_utf8_lossy(&err).into_owned(), truncated:out_truncated||err_truncated, duration_ms:start.elapsed().as_millis().min(u64::MAX as u128) as u64, timed_out })
}

pub fn validate_cwd(cwd: &Path) -> std::io::Result<PathBuf> { if cwd.is_absolute() && cwd.is_dir() { Ok(cwd.to_path_buf()) } else { Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,"cwd must be an absolute existing directory")) } }

#[cfg(test)]
mod tests {
 use super::*;
 #[tokio::test] async fn echo_and_nonzero(){let cwd=std::env::temp_dir(); let r=run("printf hello",&cwd,3).await.unwrap(); assert_eq!(r.stdout,"hello"); assert_eq!(r.exit_code,0); let r=run("exit 7",&cwd,3).await.unwrap(); assert_eq!(r.exit_code,7);}
 #[tokio::test] async fn timeout_kills(){let r=run("sleep 10",&std::env::temp_dir(),1).await.unwrap(); assert!(r.timed_out); assert!(r.duration_ms<5000);}
 #[tokio::test] async fn caps_output(){let r=run("yes x | head -c 70000",&std::env::temp_dir(),5).await.unwrap(); assert!(r.truncated); assert_eq!(r.stdout.len(),OUTPUT_LIMIT);}
 #[tokio::test] async fn rejects_bad_cwd(){assert!(run("echo no",Path::new("relative"),1).await.is_err());}
 #[tokio::test] async fn secret_env_is_scrubbed(){std::env::set_var("COMPANION_TEST_SECRET_SENTINEL","not-visible"); let r=run("printf '%s' \"${COMPANION_TEST_SECRET_SENTINEL-unset}\"",&std::env::temp_dir(),3).await.unwrap(); std::env::remove_var("COMPANION_TEST_SECRET_SENTINEL"); assert_eq!(r.stdout,"unset");}
}
