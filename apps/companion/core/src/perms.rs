use chrono::{DateTime, Utc};
use crate::protocol::{ExecutionPermission, Permissions};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action { Refuse(String), Prompt, AutoRun }
pub struct CommandRequest<'a> { pub cwd: Option<&'a str>, pub expires_at: DateTime<Utc> }

pub fn decide(permissions: &Permissions, command_request: &CommandRequest<'_>, now: DateTime<Utc>) -> Action {
    if permissions.execution == ExecutionPermission::Off { return Action::Refuse("execution is disabled".into()); }
    if command_request.expires_at <= now { return Action::Refuse("command expired".into()); }
    if command_request.cwd.is_some_and(|path| !std::path::Path::new(path).is_absolute()) { return Action::Refuse("working directory must be absolute".into()); }
    match permissions.execution { ExecutionPermission::Ask => Action::Prompt, ExecutionPermission::Always => Action::AutoRun, ExecutionPermission::Off => Action::Refuse("execution is disabled".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn perms(execution: ExecutionPermission) -> Permissions { Permissions { execution, route_traffic:false, allow_files:false, allow_browser:false } }
    fn request<'a>(cwd:Option<&'a str>,expires_at:DateTime<Utc>)->CommandRequest<'a>{CommandRequest{cwd,expires_at}}
    #[test] fn execution_off_refuses() { let now=Utc::now(); assert!(matches!(decide(&perms(ExecutionPermission::Off), &request(None,now+chrono::Duration::seconds(10)), now), Action::Refuse(_))); }
    #[test] fn expired_refuses() { let now=Utc::now(); assert!(matches!(decide(&perms(ExecutionPermission::Ask), &request(None,now), now), Action::Refuse(_))); }
    #[test] fn relative_cwd_refuses() { let now=Utc::now(); assert!(matches!(decide(&perms(ExecutionPermission::Ask), &request(Some("relative"),now+chrono::Duration::seconds(10)), now), Action::Refuse(_))); }
    #[test] fn ask_prompts() { let now=Utc::now(); assert_eq!(decide(&perms(ExecutionPermission::Ask), &request(Some("/tmp"),now+chrono::Duration::seconds(10)), now), Action::Prompt); }
    #[test] fn always_runs() { let now=Utc::now(); assert_eq!(decide(&perms(ExecutionPermission::Always), &request(None,now+chrono::Duration::seconds(10)), now), Action::AutoRun); }
}
