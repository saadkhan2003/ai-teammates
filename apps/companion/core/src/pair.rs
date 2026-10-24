use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Pairing { pub id:String, pub device_token:String }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
struct PairRequest<'a>{code:&'a str,name:&'a str,os:&'a str,version:&'a str}

fn secure_server(server:&str)->Result<Url,String>{
 let mut url=Url::parse(server).map_err(|_|"invalid server URL".to_string())?;
 let local=matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"));
 if url.scheme()!="https" && !(url.scheme()=="http"&&local){return Err("server must use HTTPS".into());}
 if !url.username().is_empty()||url.password().is_some(){return Err("server URL cannot contain credentials".into());}
 url.set_query(None);url.set_fragment(None); Ok(url)
}
pub fn complete_pairing(server:&str,code:&str,name:&str,os:&str,version:&str)->Result<Pairing,String>{
 let mut url=secure_server(server)?; url.set_path(&format!("{}/api/devices/pair/complete",url.path().trim_end_matches('/')));
 let response=reqwest::blocking::Client::new().post(url).json(&PairRequest{code,name,os,version}).send().map_err(|_|"pairing request failed".to_string())?;
 if !response.status().is_success(){return Err(format!("pairing failed with HTTP {}",response.status().as_u16()));}
 response.json::<Pairing>().map_err(|_|"invalid pairing response".into())
}

#[cfg(test)] mod tests{
 use super::*;use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
 async fn mock(status:u16,body:&'static str)->String{let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let addr=listener.local_addr().unwrap();tokio::spawn(async move{let(mut stream,_)=listener.accept().await.unwrap();let mut buf=[0;4096];let _=stream.read(&mut buf).await;let response=format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());let _=stream.write_all(response.as_bytes()).await;});format!("http://{addr}")}
 #[tokio::test]async fn success_and_bad_request(){let server=mock(200,r#"{"id":"id-1","deviceToken":"test-only-token"}"#).await;let result=tokio::task::spawn_blocking(move||complete_pairing(&server,"code","name","linux","0.4.0")).await.unwrap().unwrap();assert_eq!(result.id,"id-1");assert_eq!(result.device_token,"test-only-token");let server=mock(400,"{}").await;let err=tokio::task::spawn_blocking(move||complete_pairing(&server,"c","n","linux","0.4.0")).await.unwrap().unwrap_err();assert!(err.contains("400"));}
 #[test]fn rejects_non_https_remote(){assert!(secure_server("http://example.com").is_err());assert!(secure_server("http://localhost:8080").is_ok());assert!(secure_server("https://example.com").is_ok());}
}
