/** One place that turns a tool call or step into the short human label the working row shows. */
export type StatusEvent = { type: string; tool?: unknown; name?: unknown; args?: unknown; text?: unknown; title?: unknown; status?: unknown; label?: unknown };

export const WORKING_FALLBACK = "Working on it";
export const TYPING_LABEL = "Typing…";

const TEST_COMMAND = /\b(pytest|jest|vitest|mocha|playwright test|dotnet test|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|node --test|rspec|phpunit)\b/i;

function argsOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch { /* not JSON */ }
  }
  return {};
}

function short(value: unknown, limit = 32): string {
  const text = String(value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function fileName(value: unknown): string {
  const path = String(value ?? "").trim().replace(/\/+$/, "");
  return short(path.split("/").pop() ?? "", 40);
}

/** "Messaging Scout", "Running tests", "Writing notes.md". Unknown tools give the fallback. */
export function toolLabel(tool: string, rawArgs?: unknown): string {
  const args = argsOf(rawArgs);
  const file = fileName(args.path);
  switch (tool) {
    case "message_bot": { const bot = short(args.bot ?? args.botName ?? args.to); return bot ? `Messaging ${bot}` : "Messaging a teammate"; }
    case "reply_to_bot": { const bot = short(args.bot ?? args.botName); return bot ? `Replying to ${bot}` : "Replying to a teammate"; }
    case "list_bots": return "Looking up teammates";
    case "thread_status": return "Checking a conversation";
    case "create_bot": { const name = short(args.name); return name ? `Creating ${name}` : "Creating a teammate"; }
    case "update_bot": return "Updating a teammate";
    case "list_routines": return "Checking routines";
    case "create_routine": return "Scheduling a routine";
    case "shell": return TEST_COMMAND.test(String(args.command ?? "")) ? "Running tests" : "Running a command";
    case "setup_env": return "Running a command";
    case "browser_open": case "browser_extract": case "browser_click": case "browser": return "Browsing the web";
    case "computer_screenshot": return "Taking a screenshot";
    case "computer_click": return "Clicking on the screen";
    case "computer_type": return "Typing on the screen";
    case "computer_key": return "Pressing a key";
    case "computer_scroll": return "Scrolling the screen";
    case "record_start": case "record_stop": return "Recording the screen";
    case "type_secret": return "Signing in";
    case "request_login": return "Asking you to sign in";
    case "write_file": return file ? `Writing ${file}` : "Writing a file";
    case "edit_file": return file ? `Editing ${file}` : "Editing a file";
    case "read_file": return file ? `Reading ${file}` : "Reading a file";
    case "delete_file": return file ? `Deleting ${file}` : "Deleting a file";
    case "plan_set": return "Planning the steps";
    case "plan_update": return "Updating the plan";
    case "git_status": return "Checking git status";
    case "git_diff": return "Reviewing changes";
    case "git_commit": return "Committing changes";
    case "run_tests": return "Running tests";
    case "create_pr": return "Creating a pull request";
    case "watch_ci": return "Checking CI";
    case "spawn_child_task": return "Starting a child task";
    case "child_status": return "Checking child task";
    case "save_artifact": return "Saving a file";
    case "ask_user": return "Asking you a question";
    case "save_memory": return "Saving to memory";
    case "forget_memory": return "Updating memory";
    case "search_memory": return "Searching memory";
    case "send_message": return "Sending a message";
    case "external_post": return "Posting online";
    case "react_to_message": return "Reacting";
    default: return WORKING_FALLBACK;
  }
}

/** What the working row says: "Typing…" while a reply streams, else the live step, else the running task's title, else "Working on it". */
export function workingStatus(events: StatusEvent[], typing: boolean, taskTitle?: string, planItemTitle?: string): string {
  if (typing) return TYPING_LABEL;
  if (planItemTitle?.trim()) return `Step 2 of 5: ${planItemTitle.trim().slice(0, 72)}`;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "status" || e.type === "step") {
      const text = String(e.text ?? e.title ?? e.label ?? "").trim();
      if (text) return text.slice(0, 80);
    }
    if (e.type === "tool" || e.type === "tool_call") {
      const label = toolLabel(String(e.tool ?? e.name ?? ""), e.args);
      if (label !== WORKING_FALLBACK) return label;
    }
  }
  const title = (taskTitle ?? "").trim();
  return title ? title.slice(0, 80) : WORKING_FALLBACK;
}
