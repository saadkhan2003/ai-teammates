use async_trait::async_trait;
use companion_core::{audit::AuditLog, creds::{CredentialStore, FileStore}, session::{run_session, CommandRequest, Prompter}, version};
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

#[derive(Default)] struct AppState { pending: Mutex<HashMap<String,oneshot::Sender<bool>>>, paused: Mutex<bool> }
struct WindowPrompter { app:tauri::AppHandle, state:Arc<AppState> }
#[async_trait] impl Prompter for WindowPrompter {
 async fn ask(&self, req:&CommandRequest)->bool {
  let (tx,rx)=oneshot::channel(); if let Ok(mut pending)=self.state.pending.lock(){pending.insert(req.request_id.clone(),tx);} else{return false;}
  let label=format!("approval-{}",req.request_id);
  if let Ok(window)=WebviewWindowBuilder::new(&self.app,&label,WebviewUrl::App("index.html".into())).title("Approve command").inner_size(520.0,360.0).resizable(true).build(){tokio::time::sleep(std::time::Duration::from_millis(120)).await;let _=window.emit("approval",serde_json::json!({"requestId":req.request_id,"command":req.command,"cwd":req.cwd}));}
  match tokio::time::timeout(std::time::Duration::from_secs(60),rx).await {Ok(Ok(allow))=>allow,_=>false}
 }
 async fn is_paused(&self)->bool { self.state.paused.lock().map(|p|*p).unwrap_or(true) }
}
#[tauri::command] fn respond(request_id:String,allow:bool,state:State<'_,Arc<AppState>>)->bool {state.pending.lock().ok().and_then(|mut p|p.remove(&request_id)).is_some_and(|tx|tx.send(allow).is_ok())}
fn config_dir()->std::path::PathBuf {
 #[cfg(windows)] { return std::env::var_os("APPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Teammates/Companion"); }
 #[cfg(target_os="macos")] { return std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Library/Application Support/Teammates Companion"); }
 #[cfg(all(unix,not(target_os="macos")))] { return std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from).or_else(||std::env::var_os("HOME").map(|h|std::path::PathBuf::from(h).join(".config"))).unwrap_or_else(std::env::temp_dir).join("teammates-companion"); }
}
fn main(){
 tauri::Builder::default().manage(Arc::new(AppState::default())).invoke_handler(tauri::generate_handler![respond]).setup(|app|{
  let state=app.state::<Arc<AppState>>().inner().clone();
  let credentials=FileStore::new(config_dir()).load().ok().flatten();
  let status_text=if credentials.is_some(){"Teammates Companion — Connected"}else{"Teammates Companion — Not paired"};
  let status=MenuItem::with_id(app,"status",status_text,false,None::<&str>)?;
  let pause=MenuItem::with_id(app,"pause","Pause",true,None::<&str>)?;
  let manage=MenuItem::with_id(app,"manage","Manage devices",true,None::<&str>)?;
  let quit=MenuItem::with_id(app,"quit","Quit",true,None::<&str>)?;
  let latest=std::env::var("COMPANION_LATEST_VERSION").unwrap_or_else(|_|env!("CARGO_PKG_VERSION").to_string());
  let update=version::banner(env!("CARGO_PKG_VERSION"),&latest).unwrap_or_else(||"Up to date".into());
  let update=MenuItem::with_id(app,"update",update,false,None::<&str>)?;
  let menu=Menu::with_items(app,&[&status,&update,&pause,&manage,&quit])?;
  let manage_url=std::env::var("COMPANION_SERVER").ok().or_else(||credentials.as_ref().map(|c|c.server.clone())).unwrap_or_else(||"http://localhost:18080".into());
  let tray_state=state.clone();
  TrayIconBuilder::new().menu(&menu).on_menu_event(move |app,event|match event.id().as_ref(){"pause"=>{if let Ok(mut p)=tray_state.paused.lock(){*p=!*p;}},"manage"=>{let _=open::that(format!("{}/settings/computer",manage_url.trim_end_matches('/')));},"quit"=>app.exit(0),_=>{}}).build(app)?;
  if let (Some(credentials),Ok(audit))=(credentials,AuditLog::open(config_dir().join("audit.log"))){
   let app_handle=app.handle().clone();let prompter=Arc::new(WindowPrompter{app:app_handle,state});let audit=Arc::new(audit);
   tauri::async_runtime::spawn(async move {let _=run_session(&credentials.server,&credentials.device_id,&credentials.device_token,env!("CARGO_PKG_VERSION"),prompter.as_ref(),audit.as_ref()).await;});
  }
  Ok(())
 }).run(tauri::generate_context!()).expect("failed to start companion tray");
}
