import fs from "node:fs/promises";
import path from "node:path";
import { request } from "@playwright/test";

async function globalSetup() {
  const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:18080";
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
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await context.storageState({ path: authPath });
  } finally {
    await context.dispose();
  }
}

export default globalSetup;
