export const CONNECT_CATEGORIES = ["Password Managers", "Productivity", "Communication", "Design", "Code"] as const;

export type CatalogApp = {
  id: string;
  name: string;
  description: string;
  category: string;
  authType: string;
  kind: string;
  publisher: string;
  trust: string;
  label: string;
  blocked: boolean;
  toolCount: number;
  iconUrl: string;
};

export type InstalledApp = {
  id: string;
  catalogId: string;
  name: string;
  description: string;
  authType: string;
  status: string;
  secretId: string;
  toolCount: number;
  category: string;
  iconUrl: string;
};

export type PrivateSkill = {
  id: string;
  name: string;
  description: string;
  botName: string;
};

export type ConnectSection = { title: string; items: CatalogApp[] };

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function iconUrlOf(row: Record<string, unknown>, manifest: unknown): string {
  const direct = text(row.iconUrl ?? row.icon_url ?? row.icon ?? row.logo);
  if (/^(https?:|\/)/.test(direct)) return direct;
  const record = recordOf(typeof manifest === "string" ? safeJson(manifest) : manifest);
  const nested = text(record.iconUrl ?? record.icon ?? record.logo);
  return /^(https?:|\/)/.test(nested) ? nested : "";
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function appHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
}

export function toolCountFromManifest(manifest: unknown): number {
  let value = manifest;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return 0;
    }
  }
  const tools = recordOf(value).tools;
  return Array.isArray(tools) ? tools.length : 0;
}

export function descriptionFromManifest(manifest: unknown): string {
  let value = manifest;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return "";
    }
  }
  const record = recordOf(value);
  const summary = text(record.summary ?? record.description);
  if (summary) return summary;
  const tools = record.tools;
  if (!Array.isArray(tools) || tools.length === 0) return "";
  return text(recordOf(tools[0]).description);
}

export function readCatalogApps(data: unknown): { items: CatalogApp[]; total: number; categories: string[] } {
  const root = recordOf(data);
  const source = Array.isArray(data) ? data : Array.isArray(root.items) ? root.items : [];
  const items = source
    .map((entry) => {
      const row = recordOf(entry);
      const manifest = row.manifest;
      const description = text(row.description) || descriptionFromManifest(manifest);
      const toolCount = Number(row.toolCount ?? row.tool_count);
      return {
        id: text(row.id),
        name: text(row.name, "App"),
        description: description || text(row.publisher),
        category: text(row.category),
        authType: text(row.authType ?? row.auth_type, "none"),
        kind: text(row.kind),
        publisher: text(row.publisher),
        trust: text(row.trust),
        label: text(row.label),
        blocked: row.blocked === true,
        toolCount: Number.isFinite(toolCount) && toolCount > 0 ? toolCount : toolCountFromManifest(manifest),
        iconUrl: iconUrlOf(row, manifest),
      };
    })
    .filter((row) => row.id);
  const categories = Array.isArray(root.categories) ? root.categories.map((item) => text(item)).filter(Boolean) : [];
  return {
    items,
    total: typeof root.total === "number" ? root.total : items.length,
    categories,
  };
}

export function readInstalledApps(data: unknown): InstalledApp[] {
  const source = Array.isArray(data) ? data : Array.isArray(recordOf(data).plugins) ? (recordOf(data).plugins as unknown[]) : Array.isArray(recordOf(data).items) ? (recordOf(data).items as unknown[]) : [];
  return source
    .map((entry) => {
      const row = recordOf(entry);
      const manifest = row.manifest;
      const description = text(row.description) || descriptionFromManifest(manifest);
      const toolCount = Number(row.toolCount ?? row.tool_count);
      return {
        id: text(row.id),
        catalogId: text(row.catalogId ?? row.catalog_id),
        name: text(row.name, "App"),
        description,
        authType: text(row.authType ?? row.auth_type, "none"),
        status: text(row.status, "installed"),
        secretId: text(row.secretId ?? row.secret_id),
        toolCount: Number.isFinite(toolCount) && toolCount > 0 ? toolCount : toolCountFromManifest(manifest),
        category: text(row.category),
        iconUrl: iconUrlOf(row, manifest),
      };
    })
    .filter((row) => row.id);
}

export function readPrivateSkills(botName: string, data: unknown): PrivateSkill[] {
  const source = Array.isArray(data) ? data : Array.isArray(recordOf(data).skills) ? (recordOf(data).skills as unknown[]) : Array.isArray(recordOf(data).items) ? (recordOf(data).items as unknown[]) : [];
  return source
    .map((entry) => {
      const row = recordOf(entry);
      return {
        id: text(row.id),
        name: text(row.name, "Untitled skill"),
        description: text(row.description),
        botName,
      };
    })
    .filter((row) => row.id);
}

export function actionLabel(authType: string): "Add" | "Connect" {
  return authType === "oauth" || authType === "api_key" ? "Connect" : "Add";
}

export function isConnected(row: Pick<InstalledApp, "status" | "authType" | "secretId">): boolean {
  const status = row.status.toLowerCase();
  if (status && status !== "installed" && status !== "connected") return false;
  if (row.authType === "none" || row.authType === "") return true;
  return row.secretId.length > 0;
}

export function connectorLine(toolCount: number): string {
  const count = Math.max(0, toolCount);
  const skills = count === 1 ? "1 skill" : `${count} skills`;
  return `1 connector, ${skills}`;
}

/** Shown when the registry has not been imported yet, so the apps pill and modal are never empty. */
export const FALLBACK_RECOMMENDED: CatalogApp[] = [
  { id: "seed-notion", name: "Notion", description: "Notes, docs, and project wikis", category: "Productivity", authType: "oauth", kind: "builtin", publisher: "Notion", trust: "official", label: "tested", blocked: false, toolCount: 1, iconUrl: "" },
  { id: "seed-slack", name: "Slack", description: "Team messages and channels", category: "Communication", authType: "oauth", kind: "builtin", publisher: "Slack", trust: "official", label: "tested", blocked: false, toolCount: 1, iconUrl: "" },
  { id: "seed-gmail", name: "Gmail", description: "Email for this account", category: "Communication", authType: "oauth", kind: "builtin", publisher: "Google", trust: "official", label: "tested", blocked: false, toolCount: 1, iconUrl: "" },
];

export function catalogOrFallback(items: CatalogApp[]): CatalogApp[] {
  return items.length > 0 ? items : FALLBACK_RECOMMENDED;
}

export function recommendedApps(items: CatalogApp[]): CatalogApp[] {
  const flagged = items.filter((item) => item.trust === "official" || item.trust === "verified" || item.label === "tested" || item.label === "auto-checked");
  return (flagged.length > 0 ? flagged : items).slice(0, 6);
}

export function connectSections(items: CatalogApp[], category: string): ConnectSection[] {
  if (category === "recommended") {
    const itemsInSection = recommendedApps(items);
    return itemsInSection.length ? [{ title: "Recommended for you", items: itemsInSection }] : [];
  }
  if (category && category !== "All") {
    const matched = items.filter((item) => item.category.toLowerCase() === category.toLowerCase());
    return matched.length ? [{ title: category, items: matched }] : [];
  }
  const groups = new Map<string, CatalogApp[]>();
  for (const item of items) {
    const key = item.category || "Other";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const preview = (rows: CatalogApp[]) => (category === "All" ? rows.slice(0, 6) : rows);
  const ordered: ConnectSection[] = [];
  const recommended = recommendedApps(items);
  if (recommended.length) ordered.push({ title: "Recommended for you", items: preview(recommended) });
  for (const name of CONNECT_CATEGORIES) {
    const rows = groups.get(name);
    if (rows?.length) {
      ordered.push({ title: name, items: preview(rows) });
      groups.delete(name);
    }
  }
  for (const [title, rows] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (!rows.length) continue;
    ordered.push({ title, items: preview(rows) });
  }
  return ordered.filter((section) => section.items.length > 0);
}

export function extraCategories(fromApi: string[], items: CatalogApp[]): string[] {
  const seen = new Set<string>(CONNECT_CATEGORIES);
  const extra: string[] = [];
  for (const name of [...fromApi, ...items.map((item) => item.category)]) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    extra.push(trimmed);
  }
  return extra.sort((left, right) => left.localeCompare(right));
}

export function matchingSkills(skills: PrivateSkill[], query: string): PrivateSkill[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.botName}`.toLowerCase().includes(needle));
}
