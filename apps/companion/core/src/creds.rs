use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials { pub device_id:String, pub device_token:String, pub server:String }
pub trait CredentialStore { fn load(&self)->std::io::Result<Option<Credentials>>; fn save(&self, creds:&Credentials)->std::io::Result<()>; fn clear(&self)->std::io::Result<()>; }

pub struct FileStore { path:PathBuf }
impl FileStore { pub fn new(config_dir:impl AsRef<Path>)->Self { Self{path:config_dir.as_ref().join("credentials.json")} } }
impl CredentialStore for FileStore {
 fn load(&self)->std::io::Result<Option<Credentials>> { match fs::read(&self.path) { Ok(bytes)=>serde_json::from_slice(&bytes).map(Some).map_err(std::io::Error::other), Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None), Err(e)=>Err(e) } }
 fn save(&self, creds:&Credentials)->std::io::Result<()> { if let Some(parent)=self.path.parent(){fs::create_dir_all(parent)?;} let data=serde_json::to_vec(creds).map_err(std::io::Error::other)?; let mut opts=fs::OpenOptions::new();opts.create(true).truncate(true).write(true);
  #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;opts.mode(0o600);}
  use std::io::Write; let mut file=opts.open(&self.path)?; file.write_all(&data)?; file.sync_all()?;
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;fs::set_permissions(&self.path,fs::Permissions::from_mode(0o600))?;} Ok(()) }
 fn clear(&self)->std::io::Result<()> {match fs::remove_file(&self.path){Ok(())=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e)}}
}

#[cfg(feature="keyring")]
pub struct KeyringStore { service:String, username:String }
#[cfg(feature="keyring")]
impl KeyringStore { pub fn new(service:impl Into<String>, username:impl Into<String>)->Self{Self{service:service.into(),username:username.into()}} fn entry(&self)->keyring::Entry{keyring::Entry::new(&self.service,&self.username).expect("valid keyring identity")} }
#[cfg(feature="keyring")]
impl CredentialStore for KeyringStore {
 fn load(&self)->std::io::Result<Option<Credentials>>{match self.entry().get_password(){Ok(s)=>serde_json::from_str(&s).map(Some).map_err(std::io::Error::other),Err(keyring::Error::NoEntry)=>Ok(None),Err(_)=>Err(std::io::Error::other("credential store unavailable"))}}
 fn save(&self,c:&Credentials)->std::io::Result<()>{self.entry().set_password(&serde_json::to_string(c).map_err(std::io::Error::other)?).map_err(|_|std::io::Error::other("credential store unavailable"))}
 fn clear(&self)->std::io::Result<()>{match self.entry().delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(_)=>Err(std::io::Error::other("credential store unavailable"))}}
}

#[cfg(test)] mod tests {use super::*;#[test]fn file_store_round_trip_and_mode(){let dir=std::env::temp_dir().join(format!("companion-creds-{}",uuid::Uuid::new_v4()));let store=FileStore::new(&dir);let c=Credentials{device_id:"id".into(),device_token:"fake-token".into(),server:"https://localhost".into()};store.save(&c).unwrap();assert_eq!(store.load().unwrap(),Some(c));#[cfg(unix)]{use std::os::unix::fs::PermissionsExt;assert_eq!(fs::metadata(dir.join("credentials.json")).unwrap().permissions().mode()&0o777,0o600);}store.clear().unwrap();assert_eq!(store.load().unwrap(),None);let _=fs::remove_dir_all(dir);}}
