import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { request } from "@playwright/test";
import { PG_CONTAINER } from "./containers";

// Existing isolated test DBs may still contain the legacy 400m default.
// A quota-free stack ignores this explicit override as well as provider defaults.
function raiseTestComputerCpu(username: string) {
  const stack = process.env.STACK;
  if (!stack) throw new Error("STACK is required");
  const millis = Number(process.env.E2E_COMPUTER_CPU_MILLIS ?? "4000");
  if (!Number.isInteger(millis) || millis <= 0) throw new Error("E2E_COMPUTER_CPU_MILLIS must be a positive integer");
  const sql = `INSERT INTO user_quotas (user_id, cpu_millis) SELECT id, ${millis} FROM users WHERE username = :'u' ON CONFLICT (user_id) DO UPDATE SET cpu_millis = EXCLUDED.cpu_millis`;
  const result = spawnSync("sudo", ["-n", "docker", "exec", "-i", PG_CONTAINER, "psql", "-U", "agent", "-d", "agent", "-v", "ON_ERROR_STOP=1", "-v", `u=${username}`], { input: sql + ";\n", encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`cpu quota setup failed: ${result.error ?? result.stderr}`);
}

async function globalSetup() {
  const baseURL = process.env.BASE_URL!;
  const authPath = path.join(__dirname, ".auth", "owner.json");
  const context = await request.newContext({ baseURL });
  try {
    let response;
    for (let attempt = 1; attempt <= 3; attempt++) {
      response = await context.post("/api/auth/login", {
        data: {
          username: process.env.OWNER_USERNAME ?? "saad",
          password: process.env.OWNER_PASSWORD ?? "teammates-dev",
        },
      });
      if (response.status() !== 429 || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!response?.ok()) {
      throw new Error(`Owner login failed: ${response?.status() ?? "no response"} ${await response?.text()}`);
    }
    raiseTestComputerCpu(process.env.OWNER_USERNAME ?? "saad");
    // Computer egress is default-deny; the portal fixture host is used by acceptance, security and others.
    const policy = await context.put("/api/network-policy", { data: { mode: "team_only", entries: ["portal.example.edu"], groups: [] } });
    if (!policy.ok()) throw new Error(`network policy setup failed: ${policy.status()}`);
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await context.storageState({ path: authPath });
  } finally {
    await context.dispose();
  }
}

export default globalSetup;
