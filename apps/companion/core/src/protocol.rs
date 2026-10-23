use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub execution: ExecutionPermission,
    pub route_traffic: bool,
    pub allow_files: bool,
    pub allow_browser: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionPermission { Ask, Always, Off }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Frame {
    Hello { version: String, protocol: u8 },
    Decision { #[serde(rename = "requestId")] request_id: String, decision: DecisionKind, #[serde(skip_serializing_if = "Option::is_none")] reason: Option<String> },
    Result { #[serde(rename = "requestId")] request_id: String, #[serde(rename = "exitCode")] exit_code: i32, stdout: String, stderr: String, truncated: bool, #[serde(rename = "durationMs")] duration_ms: u64, #[serde(rename = "timedOut")] timed_out: bool },
    Pong,
    Welcome { permissions: Permissions, latest: String, #[serde(rename = "minCompatible")] min_compatible: String },
    Command { #[serde(rename = "requestId")] request_id: String, command: String, cwd: Option<String>, #[serde(rename = "timeoutSec")] timeout_sec: u16, #[serde(rename = "expiresAt")] expires_at: String },
    Cancel { #[serde(rename = "requestId")] request_id: String },
    Permissions { permissions: Permissions },
    Ping,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionKind { Approved, Denied }

/// Returns None for future protocol frame types so receivers can safely ignore them.
pub fn parse_frame(input: &str) -> Result<Option<Frame>, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(input)?;
    if !matches!(value.get("type").and_then(|v| v.as_str()), Some("hello" | "decision" | "result" | "pong" | "welcome" | "command" | "cancel" | "permissions" | "ping")) { return Ok(None); }
    serde_json::from_value(value).map(Some)
}

pub fn serialize_frame(frame: &Frame) -> Result<String, serde_json::Error> { serde_json::to_string(frame) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    #[test]
    fn every_contract_fixture_parses_and_round_trips() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/companion/fixtures");
        let mut count = 0;
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
            let input = fs::read_to_string(path).unwrap();
            let frame = parse_frame(&input).unwrap().expect("known fixture frame");
            let encoded = serialize_frame(&frame).unwrap();
            assert_eq!(serde_json::from_str::<serde_json::Value>(&input).unwrap(), serde_json::from_str::<serde_json::Value>(&encoded).unwrap());
            count += 1;
        }
        assert_eq!(count, 9);
    }
    #[test]
    fn unknown_frame_is_ignored() { assert_eq!(parse_frame(r#"{"type":"future"}"#).unwrap(), None); }
}
