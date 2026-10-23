export type Bot = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  status?: string;
  avatarShape?: string;
  avatarColor?: string;
  avatar?: string;
  model?: string;
  notificationsEnabled?: boolean;
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
  role: string;
  content: string;
  createdAt?: string;
  reactions?: Reaction[];
};

export type Approval = {
  id: string;
  action?: string;
  target?: string;
  reason?: string;
  status?: string;
  riskClass?: string;
  summary?: string;
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
  approvals: Approval[];
  secretRequests?: SecretRequest[];
  loginRequests?: LoginRequest[];
  pages: BrowserPage[];
  holder: "agent" | "human";
  llmProvider: string;
  openrouterConnected: boolean;
};

export type FileEntry = {
  path: string;
  name: string;
  size?: number;
  directory?: boolean;
};

export type MemoryItem = {
  id: string;
  content: string;
  createdAt?: string;
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
  watchKind?: string;
  watchRef?: string;
};

export type Artifact = {
  id: string;
  name: string;
  title?: string;
  mime?: string;
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
};
