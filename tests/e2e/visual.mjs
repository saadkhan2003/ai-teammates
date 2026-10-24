// Screenshots of each recreated screen at desktop and 390px, light and dark.
//   node tests/e2e/visual.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "./node_modules/playwright/index.mjs";

const base = process.env.BASE_URL || "http://127.0.0.1:18080";
const owner = process.env.OWNER_USERNAME || "saad";
const password = process.env.OWNER_PASSWORD || "teammates-dev";
const outDir = path.resolve("docs/evidence/visual");
const artifactDir = "/opt/cursor/artifacts/screenshots/visual";

const viewports = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "390", width: 390, height: 844 },
];
const themes = ["light", "dark"];

function save(page, name) {
  const file = `${name}.png`;
  const targets = [path.join(outDir, file), path.join(artifactDir, file)];
  return page.screenshot({ path: targets[0], animations: "disabled" }).then(async (buffer) => {
    fs.writeFileSync(targets[1], buffer);
    return file;
  });
}

async function shot(page, name, rows) {
  try {
    await page.waitForTimeout(250);
    const file = await save(page, name);
    rows.push({ name, file, ok: true });
    console.log("shot", file);
  } catch (error) {
    rows.push({ name, file: "", ok: false, error: String(error) });
    console.error("miss", name, error);
  }
}

async function login(context) {
  const page = await context.newPage();
  const response = await page.request.post(`${base}/api/auth/login`, {
    data: { username: owner, password },
  });
  if (!response.ok()) throw new Error(`login ${response.status()} ${await response.text()}`);
  return page;
}

async function openPane(page, narrow) {
  const sheet = page.getByTestId("sidebar");
  if (narrow && (await sheet.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape");
    if (await sheet.isVisible().catch(() => false)) await page.mouse.click(360, 160);
    await sheet.waitFor({ state: "hidden" });
  }
  const pane = page.getByTestId("info-pane");
  if (!(await pane.isVisible().catch(() => false))) {
    await page.getByTestId("bot-name-button").click();
  }
  await pane.waitFor({ state: "visible" });
  return pane;
}

function referenceFor(name) {
  const key = name.replace(/^(light|dark)-(desktop|390)-/, "");
  const dark = name.startsWith("dark-");
  const narrow = name.includes("-390-");
  const map = {
    login: "gap — our sign-in. Nearest account row: desktop_account-menu.jpg",
    home: narrow ? "mobile_bot-list_tags.jpg" : "desktop_cleaner-interface_working.jpg",
    "icon-rail": "desktop_rail_gtm.jpg",
    "plus-menu": "sidebar_plus-menu_new-bot-new-channel.jpg",
    onboarding: "onboarding_first-question-card_warm-theme.png",
    "mobile-list": narrow ? "mobile-dark_sections-list_user.jpg" : "mobile_bot-list_tags.jpg",
    chat: narrow ? "mobile_chat_message-from-bot_user.jpg" : "desktop_cleaner-interface_working.jpg",
    "context-menu": "sidebar_context-menu_move-to-section.jpg",
    "plugins-modal": "plugins-modal_dark.jpg",
    "plugins-marketplace": "marketplace-modal_plugins-and-bots.png",
    "command-palette": "command-palette_bot-switcher.png",
    "info-pane": "desktop-3pane_grocery_answered-question_empty-screen.jpg",
    "tab-overview": "desktop_bot-settings-pane.jpg",
    "tab-computer": "desktop-3pane_question-card-open_live-screen.jpg",
    "tab-routines": "group-chat_members-pane_empty-routines.jpg",
    "tab-files-media": "file-preview-modal_html.png",
    "tab-skills": "chat_teach-demo-skill_launch.jpg",
    "tab-memory": "mobile-dark_bot-details.jpg",
    "tab-tasks": "desktop_routine-editor.jpg",
    "tab-plugins": "plugins_added-list-crop.jpg",
    "computer-fullscreen": "computer-fullscreen_browser.jpg",
    "bot-settings": "bot-settings_pane_v1.jpg",
    "mobile-details": "mobile-dark_bot-details.jpg",
    "settings-general": "settings-modal_general_auto-review.png",
    "settings-computer": "gap — no public image (Computer)",
    "settings-vault": "gap — no public image (Vault)",
    "settings-usage": "gap — no public image (Usage & Billing)",
    "settings-updates": "gap — no public image (Updates)",
    "settings-system": "gap — no public image (admin health)",
    gallery: "chat_question-card_multiselect_v2.jpg",
  };
  let ref = map[key] || "gap — no matching public image";
  if (dark && !narrow && ["home", "chat", "info-pane", "icon-rail", "command-palette"].includes(key)) {
    ref = "gap — no public image (full desktop dark). Nearest: mobile-dark_chat.jpg";
  }
  if (!dark && key === "plugins-modal") ref = "plugin-row_add.jpg";
  if (dark && narrow && key === "chat") ref = "mobile-dark_chat.jpg";
  if (dark && narrow && key === "mobile-list") ref = "mobile-dark_bot-list_user.jpg";
  if (dark && narrow && key === "home") ref = "mobile-dark_bot-list_user.jpg";
  return `\`${ref}\``;
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const rows = [];
  try {
    for (const theme of themes) {
      for (const viewport of viewports) {
        const prefix = `${theme}-${viewport.id}`;
        if (process.env.VISUAL_ONLY && !prefix.includes(process.env.VISUAL_ONLY)) continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: viewport.width < 500 ? 2 : 1,
          isMobile: viewport.width < 500,
          hasTouch: viewport.width < 500,
        });
        await context.addInitScript((mode) => {
          localStorage.setItem("teammates-theme", mode);
        }, theme);
        const narrow = viewport.width < 500;
        try {
        const guest = await context.newPage();
        await guest.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
        await guest.getByTestId("login-card").waitFor();
        await shot(guest, `${prefix}-login`, rows);
        await guest.close();

        const page = await login(context);

        await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
        await page.getByTestId(narrow ? "mobile-list" : "sidebar").waitFor();
        await shot(page, `${prefix}-home`, rows);

        if (!narrow) {
          await page.getByTestId("rail-toggle").click();
          await shot(page, `${prefix}-icon-rail`, rows);
          await page.getByTestId("rail-toggle").click();
        }

        if (narrow) {
          await page.getByTestId("sidebar-toggle").click();
          await page.getByTestId("sidebar").waitFor();
        }
        await page.getByTestId("new-bot").click();
        await page.getByTestId("plus-menu").waitFor();
        await shot(page, `${prefix}-plus-menu`, rows);
        await page.getByRole("menuitem", { name: "New teammate" }).click();
        await page.getByTestId("bot-name").waitFor();
        await shot(page, `${prefix}-onboarding`, rows);
        await page.keyboard.press("Escape");

        const bots = await (await page.request.get(`${base}/api/bots`)).json();
        const list = Array.isArray(bots) ? bots : [];
        const bot = list[0];
        if (!bot) {
          rows.push({ name: `${prefix}-chat`, file: "", ok: false, error: "no bots" });
          await context.close();
          continue;
        }

        if (narrow) {
          await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
          await page.getByTestId("mobile-list").waitFor();
          await shot(page, `${prefix}-mobile-list`, rows);
        }

        await page.goto(`${base}/bots/${bot.id}`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("composer").waitFor();
        await shot(page, `${prefix}-chat`, rows);

        const link = page.getByTestId("sidebar").getByRole("link", { name: bot.name }).first();
        if (!narrow) {
          await link.click({ button: "right" });
          await page.getByRole("menuitem", { name: "Delete" }).waitFor();
          await shot(page, `${prefix}-context-menu`, rows);
          await page.keyboard.press("Escape");
        } else {
          if (!(await page.getByTestId("sidebar").isVisible().catch(() => false))) {
            await page.getByTestId("sidebar-toggle").click();
          }
          await page.getByTestId("sidebar").waitFor();
          await link.click({ button: "right" });
          await page.getByRole("menuitem", { name: "Delete" }).waitFor().catch(() => undefined);
          await shot(page, `${prefix}-context-menu`, rows);
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }

        const pluginsButton = page.getByTestId("open-plugins");
        if (narrow && !(await page.getByTestId("sidebar").isVisible().catch(() => false))) {
          await page.getByTestId("sidebar-toggle").click();
        }
        if (await pluginsButton.isVisible().catch(() => false)) {
          await pluginsButton.click();
          await page.getByTestId("plugins-modal").waitFor();
          await shot(page, `${prefix}-plugins-modal`, rows);
          const manage = page.getByTestId("connect-manage");
          if (await manage.isVisible().catch(() => false)) {
            await manage.click();
            await shot(page, `${prefix}-plugins-marketplace`, rows);
          }
          await page.keyboard.press("Escape");
        }

        await page.keyboard.press("Control+k");
        await page.getByTestId("command-palette").waitFor();
        await shot(page, `${prefix}-command-palette`, rows);
        await page.keyboard.press("Escape");

        const pane = await openPane(page, narrow);
        await shot(page, `${prefix}-info-pane`, rows);
        for (const tab of ["Overview", "Computer", "Routines", "Files", "Skills", "Memory", "Tasks", "Plugins"]) {
          const trigger = pane.getByRole("tab", { name: tab, exact: true });
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
          await shot(page, `${prefix}-tab-${tab.toLowerCase().replace("/", "-")}`, rows);
        }

        const frame = page.getByTestId("desktop-frame");
        if (await frame.isVisible().catch(() => false)) {
          await frame.click();
          await page.getByTestId("take-control").waitFor({ timeout: 8000 }).catch(() => undefined);
          await shot(page, `${prefix}-computer-fullscreen`, rows);
          const close = page.locator("[data-testid='computer-tab']").getByRole("button", { name: "Close", exact: true });
          if (await close.isVisible().catch(() => false)) {
            await close.click();
            await close.waitFor({ state: "hidden" });
          }
        }

        await openPane(page, narrow);
        await page.getByTestId("bot-settings-gear").click();
        await page.getByTestId("bot-settings").waitFor();
        await shot(page, `${prefix}-bot-settings`, rows);

        if (narrow) await shot(page, `${prefix}-mobile-details`, rows);

        const settings = [
          ["general", "/settings"],
          ["computer", "/settings/computer"],
          ["vault", "/settings/secrets"],
          ["usage", "/settings/usage"],
          ["updates", "/settings/updates"],
          ["system", "/system"],
        ];
        for (const [label, href] of settings) {
          await page.goto(`${base}${href}`, { waitUntil: "domcontentloaded" });
          await page.getByRole("heading", { name: "Settings" }).waitFor();
          await shot(page, `${prefix}-settings-${label}`, rows);
        }

        await page.goto(`${base}/dev/screens`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("screen-gallery").waitFor();
        await page.waitForTimeout(400);
        const gallery = `${prefix}-gallery.png`;
        const buffer = await page.screenshot({ fullPage: true, animations: "disabled" });
        fs.writeFileSync(path.join(outDir, gallery), buffer);
        fs.writeFileSync(path.join(artifactDir, gallery), buffer);
        rows.push({ name: `${prefix}-gallery`, file: gallery, ok: true });
        console.log("shot", gallery);

        } catch (error) {
          rows.push({ name: `${prefix}-aborted`, file: "", ok: false, error: String(error).split("\n")[0] });
          console.error("abort", prefix, error);
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const lines = [
    "# Visual pass",
    "",
    "Paired with `SPEC.md` and the 99 public screenshots in the reference pack. Our mark, name, and copper accent stay. Grok logos, the wordmark, and the blob mascot are not copied. Dark desktop and the Settings tabs other than General have no public image; those rows say so.",
    "",
    "| Screen | Reference image | Our screenshot |",
    "| --- | --- | --- |",
  ];
  const seen = new Set();
  const indexed = [...rows];
  for (const file of fs.readdirSync(outDir).filter((name) => name.endsWith(".png")).sort()) {
    const name = file.replace(/\.png$/, "");
    if (indexed.some((row) => row.name === name)) continue;
    indexed.push({ name, file, ok: true });
  }
  for (const row of indexed) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const ours = row.ok ? `[\`${row.file}\`](./${row.file})` : `failed: ${row.error}`;
    lines.push(`| ${row.name} | ${referenceFor(row.name)} | ${ours} |`);
  }
  const index = lines.join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "INDEX.md"), index);
  console.log(`wrote ${rows.filter((row) => row.ok).length}/${rows.length} shots`);
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
