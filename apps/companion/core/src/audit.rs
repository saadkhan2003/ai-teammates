use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs::{File, OpenOptions}, io::Write, path::Path, sync::Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct AuditEntry { pub time:String, pub request_id:String, pub command_sha256:String, pub command:String, pub decision:String, pub exit_code:Option<i32>, pub duration_ms:Option<u64>, pub source:String }

pub struct AuditLog { file: Mutex<File> }
impl AuditLog {
 pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
  let mut opts=OpenOptions::new(); opts.create(true).append(true).write(true);
  #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
  let file=opts.open(&path)?;
  #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path.as_ref(),std::fs::Permissions::from_mode(0o600))?; }
  Ok(Self{file:Mutex::new(file)})
 }
 pub fn append(&self, request_id:&str, command:&str, decision:&str, exit_code:Option<i32>, duration_ms:Option<u64>, source:&str)->std::io::Result<()> {
  if !matches!(source,"server"|"always") { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,"invalid audit source")); }
  let digest=Sha256::digest(command.as_bytes()).iter().map(|b|format!("{b:02x}")).collect::<String>();
  let row=AuditEntry{time:Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true), request_id:request_id.to_string(), command_sha256:digest, command:command.to_string(), decision:decision.to_string(), exit_code,duration_ms,source:source.to_string()};
  let mut file=self.file.lock().map_err(|_|std::io::Error::other("audit lock poisoned"))?;
  serde_json::to_writer(&mut *file,&row).map_err(std::io::Error::other)?; file.write_all(b"\n")?; file.flush()
 }
}
#[cfg(test)] mod tests { use super::*; #[test] fn append_is_json_and_restrictive(){let dir=std::env::temp_dir().join(format!("companion-audit-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&dir).unwrap(); let path=dir.join("audit.log"); let log=AuditLog::open(&path).unwrap(); log.append("req-1","echo hi","approved",Some(0),Some(1),"server").unwrap(); let row:serde_json::Value=serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap(); assert_eq!(row["command"],"echo hi"); assert!(row.get("stdout").is_none()); #[cfg(unix)] {use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode()&0o777,0o600);} std::fs::remove_dir_all(dir).unwrap();} }
