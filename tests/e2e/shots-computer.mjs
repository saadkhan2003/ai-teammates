// Screenshots of a bot's real desktop (via the computer service) and the web fullscreen view.
//   BASE_URL=... OWNER_PASSWORD=... node tests/e2e/shots-computer.mjs
import { chromium } from "./node_modules/playwright/index.mjs";
const base = process.env.BASE_URL || "http://127.0.0.1:18080";
const out = process.env.SHOT_DIR || "../../shots";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 576 } });
const page = await ctx.newPage();
const r = await page.request.post(`${base}/api/auth/login`, { data: { username: process.env.OWNER_USERNAME || "saad", password: process.env.OWNER_PASSWORD || "teammates-dev" } });
if (!r.ok()) throw new Error("login " + r.status());
let bots = await (await page.request.get(`${base}/api/bots`)).json();
bots = bots.bots ?? bots;
let bot = bots[0];
if (!bot) { const m = await (await page.request.post(`${base}/api/bots`, { data: { name: "Screen" } })).json(); bot = m.bot ?? m; }
await page.goto(`${base}/bots/${bot.id}`);
await page.getByTestId("bot-name-button").waitFor();
if ((await page.getByTestId("bot-name-button").getAttribute("aria-expanded")) !== "true") await page.getByTestId("bot-name-button").click();
await page.getByTestId("desktop-frame").click();
await page.getByTestId("computer-topbar").waitFor();
await page.waitForTimeout(8000);
await page.screenshot({ path: `${out}/9-computer-web.png` });
await browser.close();
