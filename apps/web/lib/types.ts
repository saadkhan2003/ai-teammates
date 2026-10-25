import type { BotThreadView } from "@/lib/bot-thread";
export type Bot = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  status?: string;
  avatarShape?: string;
  isPrimary?: boolean;
  bio?: string;
  avatarColor?: string;
  avatar?: string;
  notificationsEnabled?: boolean;
  peerMessaging?: boolean;
};

export type Task = {
  id: string;
  title?: string;
  instruction?: string;
  status: string;
  kind?: string;
  modelCalls?: number;
  waitingReason?: string;
  error?: string;
  errorCode?: string;
  result?: string;
};

export type Reaction = {
  id?: string;
  actorType: string;
  actorId?: string;
  emoji: string;
  createdAt?: string;
};

export type ChatMessage = {
  id: string;
  clientId?: string | null;
  sendState?: "pending" | "failed";
  role: string;
  content: string;
  createdAt?: string;
  replyTo?: string | null;
  reactions?: Reaction[];
  parts?: MessagePartView[] | null;
  skill?: { id: string; label: string } | null;
  attachments?: Array<{ path: string; name: string; mime?: string }> | null;
  videoAnalysis?: { summary?: string; duration?: number; timeline?: Array<{ timestamp?: number; summary?: string }> } | null;
  deleted?: boolean;
  requestId?: string | null;
  taskStatus?: string | null;
  replyToMessageId?: string | null;
  kind?: string;
  childTasks?: Array<{ taskId: string; title: string; status: string; hasBrief: boolean }>;
  replyToId?: string;
};

export type CodingJob = {
  id: string;
  title: string;
  status: string;
  step?: string;
  prNumber?: number | null;
  prUrl?: string;
  branch?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  updatedAt?: string;
  taskId?: string;
};

export type MessagePartView =
  | { type: "text"; text: string }
  | { type: "quote"; text: string; sourceMessageId?: string | null }
  | { type: "reply"; messageId: string; author?: string; excerpt?: string }
  | { type: "widget"; widget: unknown };

export type Approval = {
  id: string;
  action?: string;
  target?: string;
  reason?: string;
  status?: string;
  riskClass?: string;
  summary?: string;
  /** Pending on another teammate's task that this teammate started. Deciding it here decides it everywhere. */
  relayed?: boolean;
  threadId?: string | null;
  threadTitle?: string | null;
  requestedBy?: string | null;
  botName?: string | null;
};

export type LoginField = {
  kind: string;
  selector?: string;
  label?: string;
};

export type LoginRequest = {
  id: string;
  domain: string;
  url?: string;
  fields?: LoginField[];
  status?: string;
  expiresAt?: string;
};

export type SecretRequest = {
  id: string;
  suggestedRef?: string;
  type?: string;
  reason?: string;
  status?: string;
};

export type BrowserPage = {
  targetId: string;
  url: string;
  title?: string;
};

export type Workspace = {
  bot: Bot;
  conversationId: string;
  tasks: Task[];
  messages: ChatMessage[];
  messagesHasMore?: boolean;
  approvals: Approval[];
  botThreads?: BotThreadView[];
  secretRequests?: SecretRequest[];
  loginRequests?: LoginRequest[];
  pages: BrowserPage[];
  holder: "agent" | "human";
  aiConnected: boolean;
  codingJobs?: CodingJob[];
};

export type FileEntry = {
  path: string;
  name: string;
  size?: number;
  directory?: boolean;
  updatedAt?: string;
};

export type MemoryItem = {
  id: string;
  content: string;
  kind: "profile" | "rule" | "journal" | "fact" | "summary";
  status: string;
  pinned: boolean;
  visibility: string;
  author: string;
  createdAt?: string;
  updatedAt?: string;
  lastConfirmedAt?: string;
};

export type Skill = {
  id: string;
  name: string;
  description?: string;
  version?: string | number;
};

export type Routine = {
  id: string;
  name: string;
  cron: string;
  instruction?: string;
  nextRunAt?: string;
  enabled?: boolean;
  watchKind?: string;
  watchRef?: string;
  kind?: "recurring" | "once" | string;
  runAt?: string;
  timezone?: string;
  pausedReason?: string | null;
  failureStreak?: number;
  quietRule?: string | null;
  expiresAt?: string | null;
  jitterSeconds?: number;
  runs?: RoutineRun[];
};

export type RoutineRun = {
  id: string;
  taskId?: string | null;
  status: string;
  triggeredAt?: string;
  finishedAt?: string | null;
  scheduledFor?: string | null;
  error?: string | null;
  skipReason?: string | null;
  summary?: string | null;
  notified?: boolean;
};

export type Artifact = {
  id: string;
  name: string;
  title?: string;
  mime?: string;
  size?: number;
  createdAt?: string;
};

export type SecretRecord = {
  id: string;
  name: string;
  namespace: string;
  type: string;
  maskedSuffix: string;
  validationStatus?: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  allowedDomains: string[];
  allowedTools: string[];
};

export type SecretUsageEvent = {
  id: string;
  event?: string;
  actor?: string;
  botId?: string;
  taskId?: string;
  tool?: string;
  destination?: string;
  decision?: string;
  reasonCode?: string;
  createdAt?: string;
};

export type SecretTestResult = {
  state: "valid" | "invalid";
  limitRemaining?: number;
};

export type DesktopToken = {
  token: string;
  mode: string;
  epoch?: number;
};
