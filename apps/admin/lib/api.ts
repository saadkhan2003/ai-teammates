export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function detail(body: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const value = json.detail ?? json.error ?? json.message;
    if (typeof value === "string") return value.slice(0, 280);
  } catch {
    return "";
  }
  return "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include", cache: "no-store" });
  } catch {
    throw new ApiError(0, "The network request failed.");
  }
  if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
  if (response.status === 401) throw new ApiError(401, "Sign in required.");
  if (!response.ok) {
    throw new ApiError(response.status, detail(await response.text().catch(() => "")) || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined as T;
  return (await response.json()) as T;
}

export function staffRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "support" || role === "readonly";
}

export function canSupport(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "support";
}

export function canOperate(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canOwn(role: string | undefined): boolean {
  return role === "owner";
}
