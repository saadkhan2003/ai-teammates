use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use std::{path::Path, time::Duration};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message}};
use crate::{audit::AuditLog, perms::{self, Action, CommandRequest as PermissionRequest}, protocol::{parse_frame, serialize_frame, DecisionKind, ExecutionPermission, Frame, Permissions}, runner, version};

#[derive(Debug, Clone)]
pub struct CommandRequest { pub request_id:String, pub command:String, pub cwd:Option<String>, pub timeout_sec:u16, pub expires_at:String }
#[async_trait]
pub trait Prompter: Send + Sync { async fn ask(&self, req:&CommandRequest)->bool; async fn is_paused(&self)->bool { false } }

pub async fn run_session(server:&str, device_id:&str, token:&str, current_version:&str, prompter:&dyn Prompter, audit:&AuditLog)->Result<(),String>{
 let mut backoff=Duration::from_secs(1);
 loop {
  match run_connection(server,device_id,token,current_version,prompter,audit).await {
   Ok(())=>return Ok(()), Err(_)=>{tokio::time::sleep(backoff).await;backoff=(backoff*2).min(Duration::from_secs(60));}
  }
 }
}

async fn run_connection(server:&str,device_id:&str,token:&str,current_version:&str,prompter:&dyn Prompter,audit:&AuditLog)->Result<(),String>{
 let mut url=url::Url::parse(server).map_err(|_|"invalid server URL")?;
 match url.scheme(){"https"=>url.set_scheme("wss").map_err(|_|"invalid websocket URL")?,"http" if matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"))=>url.set_scheme("ws").map_err(|_|"invalid websocket URL")?,"wss"=>{},"ws" if matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"))=>{},_=>return Err("server must use TLS".into())}
 url.set_path(&format!("{}/api/devices/{}/connect",url.path().trim_end_matches('/'),device_id));url.set_query(None);url.set_fragment(None);
 let mut request=url.as_str().into_client_request().map_err(|_|"invalid websocket request")?;
 request.headers_mut().insert("Authorization",format!("Bearer {token}").parse().map_err(|_|"invalid authorization header")?);
 let (mut ws,_)=connect_async(request).await.map_err(|_|"websocket connection failed")?;
 let hello=Frame::Hello{version:current_version.into(),protocol:1};ws.send(Message::Text(serialize_frame(&hello).map_err(|_|"frame serialization failed")?.into())).await.map_err(|_|"websocket send failed")?;
 let mut permissions:Option<Permissions>=None;
 while let Some(message)=ws.next().await {
  let message=message.map_err(|_|"websocket receive failed")?;
  match message {
   Message::Text(text)=>{let Some(frame)=parse_frame(&text).map_err(|_|"invalid protocol frame")? else{continue};match frame{
    Frame::Welcome{permissions:p,min_compatible,..}=>{if !version::compatible(current_version,&min_compatible){return Ok(());} permissions=Some(p);}
    Frame::Permissions{permissions:p}=>permissions=Some(p),
    Frame::Ping=>ws.send(Message::Text(serialize_frame(&Frame::Pong).map_err(|_|"frame serialization failed")?.into())).await.map_err(|_|"websocket send failed")?,
    Frame::Command{request_id,command,cwd,timeout_sec,expires_at}=>{
     let request=CommandRequest{request_id,command,cwd,timeout_sec,expires_at};
     process_command(&mut ws,&request,permissions.as_ref(),current_version,prompter,audit).await?;
    }
    Frame::Cancel{..}=>{}, Frame::Pong|Frame::Hello{..}|Frame::Decision{..}|Frame::Result{..}=>{}
   }}
   Message::Close(_)=>return Err("websocket closed".into()), Message::Ping(payload)=>ws.send(Message::Pong(payload)).await.map_err(|_|"websocket send failed")?, _=>{}
  }
 }
 Err("websocket disconnected".into())
}

async fn process_command<S>(ws:&mut S,request:&CommandRequest,permissions:Option<&Permissions>,_current_version:&str,prompter:&dyn Prompter,audit:&AuditLog)->Result<(),String>
where S:futures_util::Sink<Message>+futures_util::Stream<Item=Result<Message,tokio_tungstenite::tungstenite::Error>>+Unpin, <S as futures_util::Sink<Message>>::Error:std::fmt::Display {
 let now=Utc::now();let expires=DateTime::parse_from_rfc3339(&request.expires_at).map(|d|d.with_timezone(&Utc)).unwrap_or(DateTime::<Utc>::MIN_UTC);
 let missing=Permissions{execution:ExecutionPermission::Off,route_traffic:false,allow_files:false,allow_browser:false};
 let p=permissions.unwrap_or(&missing);
 let permission_request=PermissionRequest{cwd:request.cwd.as_deref(),expires_at:expires};
 let action=if request.command.trim().is_empty(){Action::Refuse("command is empty".into())}else if request.cwd.as_deref().is_some_and(|cwd|runner::validate_cwd(Path::new(cwd)).is_err()){Action::Refuse("working directory must be an absolute existing directory".into())}else{perms::decide(p,&permission_request,now)};
 let mut allowed=if prompter.is_paused().await {false}else{match action {Action::Refuse(_)=>false,Action::AutoRun=>true,Action::Prompt=>tokio::time::timeout(Duration::from_secs(60),prompter.ask(request)).await.unwrap_or(false)}};
 if expires<=Utc::now()||prompter.is_paused().await {allowed=false;}
 let kind=if allowed{DecisionKind::Approved}else{DecisionKind::Denied};
 let (decision_label,source)=if p.execution==ExecutionPermission::Always&&allowed{("approved","always")}else if allowed{("approved","server")}else{("denied","server")};
 if !allowed {let _=audit.append(&request.request_id,&request.command,"denied",None,None,source);}
 let decision=Frame::Decision{request_id:request.request_id.clone(),decision:kind,reason:if allowed{None}else{Some("denied by local permissions or user".into())}};
 ws.send(Message::Text(serialize_frame(&decision).map_err(|e|e.to_string())?.into())).await.map_err(|e|e.to_string())?;
 if allowed {
  let cwd=request.cwd.as_deref().map(Path::new).unwrap_or_else(||Path::new(if cfg!(windows){"C:\\"}else{"/"}));
  let execution=runner::run(&request.command,cwd,request.timeout_sec as u64);tokio::pin!(execution);
  let result=loop {tokio::select!{
   result=&mut execution=>break Some(result),
   incoming=ws.next()=>match incoming {
    Some(Ok(Message::Text(text)))=>match parse_frame(&text).map_err(|_|"invalid protocol frame")? {
     Some(Frame::Cancel{request_id}) if request_id==request.request_id=>{let _=audit.append(&request.request_id,&request.command,"cancelled",None,None,source);break None;},
     Some(Frame::Permissions{permissions}) if permissions.execution==ExecutionPermission::Off=>{let _=audit.append(&request.request_id,&request.command,"cancelled",None,None,source);break None;},
     Some(Frame::Ping)=>ws.send(Message::Text(serialize_frame(&Frame::Pong).map_err(|e|e.to_string())?.into())).await.map_err(|e|e.to_string())?,
     Some(Frame::Pong|Frame::Cancel{..}|Frame::Permissions{..})|None=>{},
     Some(_)=>return Err("unexpected frame while command is running".into()),
    },
    Some(Ok(Message::Ping(payload)))=>ws.send(Message::Pong(payload)).await.map_err(|e|e.to_string())?,
    Some(Ok(Message::Close(_)))|None=>return Err("websocket disconnected".into()),
    Some(Err(_))=>return Err("websocket receive failed".into()),
    _=>{},
   }
  }};
  let Some(result)=result else{return Ok(());};
  let result=result.map_err(|_|"command could not be started".to_string())?;
  let _=audit.append(&request.request_id,&request.command,decision_label,Some(result.exit_code),Some(result.duration_ms),source);
  let frame=Frame::Result{request_id:request.request_id.clone(),exit_code:result.exit_code,stdout:result.stdout,stderr:result.stderr,truncated:result.truncated,duration_ms:result.duration_ms,timed_out:result.timed_out};
  ws.send(Message::Text(serialize_frame(&frame).map_err(|e|e.to_string())?.into())).await.map_err(|e|e.to_string())?;
 }
 Ok(())
}

#[cfg(test)] mod tests {
 use super::*;
 use async_trait::async_trait;
 use std::{sync::{Arc,atomic::{AtomicUsize,Ordering}},fs};
 use tokio::net::TcpListener;
 use tokio_tungstenite::{accept_async, tungstenite::Message};
 struct TestPrompt{answer:bool,calls:Arc<AtomicUsize>}
 #[async_trait] impl Prompter for TestPrompt{async fn ask(&self,_:&CommandRequest)->bool{self.calls.fetch_add(1,Ordering::SeqCst);self.answer}}
 fn permissions(execution:ExecutionPermission)->Permissions{Permissions{execution,route_traffic:false,allow_files:false,allow_browser:false}}
 async fn setup(command:String,execution:ExecutionPermission,expires:String,approve:bool)->(Result<(),String>,Vec<Frame>,usize,std::path::PathBuf){
  let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();
  let (tx,rx)=tokio::sync::oneshot::channel();
  let server=tokio::spawn(async move{
   let(stream,_)=listener.accept().await.unwrap();let mut ws=accept_async(stream).await.unwrap();
   let hello=ws.next().await.unwrap().unwrap();assert!(hello.into_text().unwrap().contains("\"type\":\"hello\""));
   let welcome=Frame::Welcome{permissions:permissions(execution),latest:"0.4.0".into(),min_compatible:"0.4.0".into()};ws.send(Message::Text(serialize_frame(&welcome).unwrap().into())).await.unwrap();
   let cmd=Frame::Command{request_id:"7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f".into(),command,cwd:Some("/tmp".into()),timeout_sec:3,expires_at:expires};ws.send(Message::Text(serialize_frame(&cmd).unwrap().into())).await.unwrap();
   let mut received=Vec::new();let decision=ws.next().await.unwrap().unwrap().into_text().unwrap().to_string();received.push(parse_frame(&decision).unwrap().unwrap());
   if matches!(received[0],Frame::Decision{decision:DecisionKind::Approved,..}) {let result=ws.next().await.unwrap().unwrap().into_text().unwrap().to_string();received.push(parse_frame(&result).unwrap().unwrap());}
   let _=ws.close(None).await;tx.send(received).unwrap();
  });
  let dir=std::env::temp_dir().join(format!("companion-session-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let audit=AuditLog::open(dir.join("audit.log")).unwrap();let calls=Arc::new(AtomicUsize::new(0));let prompt=TestPrompt{answer:approve,calls:calls.clone()};let url=format!("http://{addr}");let result=run_connection(&url,"device-id","fake-token","0.4.0",&prompt,&audit).await;let messages=rx.await.unwrap();server.await.unwrap();(result,messages,calls.load(Ordering::SeqCst),dir)
 }
 #[tokio::test] async fn approved_command_returns_result_and_audit(){let(result,messages,calls,dir)=setup("printf approved".into(),ExecutionPermission::Ask,(Utc::now()+chrono::Duration::seconds(60)).to_rfc3339(),true).await;assert!(result.is_err());assert_eq!(calls,1);assert!(matches!(messages.as_slice(),[Frame::Decision{decision:DecisionKind::Approved,..},Frame::Result{exit_code:0,stdout,..}] if stdout=="approved"));let line=fs::read_to_string(dir.join("audit.log")).unwrap();assert!(line.contains("approved"));fs::remove_dir_all(dir).unwrap();}
 #[tokio::test] async fn deny_sends_decision_and_does_not_run(){let(result,messages,calls,dir)=setup("touch /tmp/companion-must-not-run".into(),ExecutionPermission::Ask,(Utc::now()+chrono::Duration::seconds(60)).to_rfc3339(),false).await;assert!(result.is_err());assert_eq!(calls,1);assert!(matches!(messages.as_slice(),[Frame::Decision{decision:DecisionKind::Denied,..}]));assert!(!Path::new("/tmp/companion-must-not-run").exists());fs::remove_dir_all(dir).unwrap();}
 #[tokio::test] async fn off_and_expired_refuse_without_prompt(){for (permission,expiry) in [(ExecutionPermission::Off,(Utc::now()+chrono::Duration::seconds(60)).to_rfc3339()),(ExecutionPermission::Ask,(Utc::now()-chrono::Duration::seconds(60)).to_rfc3339())]{let(_,messages,calls,dir)=setup("touch /tmp/companion-must-not-run".into(),permission,expiry,true).await;assert_eq!(calls,0);assert!(matches!(messages.as_slice(),[Frame::Decision{decision:DecisionKind::Denied,..}]));fs::remove_dir_all(dir).unwrap();}}
 #[tokio::test] async fn cancel_kills_running_command(){let marker=std::env::temp_dir().join(format!("companion-cancel-{}",uuid::Uuid::new_v4()));let command=format!("sleep 5; touch {}",marker.display());let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();let server=tokio::spawn(async move{let(stream,_)=listener.accept().await.unwrap();let mut ws=accept_async(stream).await.unwrap();let _=ws.next().await;let welcome=Frame::Welcome{permissions:permissions(ExecutionPermission::Always),latest:"0.4.0".into(),min_compatible:"0.4.0".into()};ws.send(Message::Text(serialize_frame(&welcome).unwrap().into())).await.unwrap();let cmd=Frame::Command{request_id:"cancel-me".into(),command,cwd:Some("/tmp".into()),timeout_sec:10,expires_at:(Utc::now()+chrono::Duration::seconds(60)).to_rfc3339()};ws.send(Message::Text(serialize_frame(&cmd).unwrap().into())).await.unwrap();let _=ws.next().await;let cancel=Frame::Cancel{request_id:"cancel-me".into()};ws.send(Message::Text(serialize_frame(&cancel).unwrap().into())).await.unwrap();tokio::time::sleep(Duration::from_millis(100)).await;let _=ws.close(None).await;});let dir=std::env::temp_dir().join(format!("companion-cancel-audit-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let audit=AuditLog::open(dir.join("audit.log")).unwrap();let prompt=TestPrompt{answer:false,calls:Arc::new(AtomicUsize::new(0))};let _=run_connection(&format!("http://{addr}"),"id","fake-token","0.4.0",&prompt,&audit).await;server.await.unwrap();assert!(!marker.exists());assert!(fs::read_to_string(dir.join("audit.log")).unwrap().contains("cancelled"));fs::remove_file(marker).ok();fs::remove_dir_all(dir).unwrap();}
 #[tokio::test] async fn reconnects_after_drop(){let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();let server=tokio::spawn(async move{for attempt in 0..2{let(stream,_)=listener.accept().await.unwrap();let mut ws=accept_async(stream).await.unwrap();let _=ws.next().await;let minimum=if attempt==0{"0.4.0"}else{"1.0.0"};let welcome=Frame::Welcome{permissions:permissions(ExecutionPermission::Off),latest:"1.0.0".into(),min_compatible:minimum.into()};let _=ws.send(Message::Text(serialize_frame(&welcome).unwrap().into())).await;let _=ws.close(None).await;}});let dir=std::env::temp_dir().join(format!("companion-reconnect-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();let audit=AuditLog::open(dir.join("audit.log")).unwrap();let calls=Arc::new(AtomicUsize::new(0));let prompt=TestPrompt{answer:false,calls};let result=run_session(&format!("http://{addr}"),"id","fake-token","0.4.0",&prompt,&audit).await;assert!(result.is_ok());server.await.unwrap();fs::remove_dir_all(dir).unwrap();}
}

