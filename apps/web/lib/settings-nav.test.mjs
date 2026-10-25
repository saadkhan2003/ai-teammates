import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { settingsGroups } from "../components/settings-nav-config.mjs";
import { settingsNavGroups } from "../components/settings-nav-data.mjs";

const items = settingsGroups.flatMap((group) => group.items);
const source = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const webGuide = source("./app-guide.json");
const guide = JSON.parse(webGuide);

test("settings navigation has unique ids, labels, and destinations across groups", () => {
  for (const key of ["id", "label", "href"]) {
    const values = items.map((item) => item[key]);
    assert.equal(new Set(values).size, values.length, `duplicate settings ${key}`);
  }
  assert.deepEqual(settingsGroups.map((group) => group.heading), ["Preferences", "Account", "Workspace", "Billing", "Support", "Legal", "Staff"]);
  assert.equal(settingsGroups.find((group) => group.heading === "Workspace").items.some((item) => item.id === "skills"), true);
  assert.deepEqual(items.filter((item) => item.admin).map((item) => item.id), ["video-admin-config", "system", "support-inbox", "incidents"]);
  assert.strictEqual(settingsNavGroups, settingsGroups);
});

test("every settings destination has a route, icon, and matching app-guide anchor", () => {
  const nav = source("../components/settings-nav.tsx");
  for (const item of items) {
    const page = source(`../app${item.href}/page.tsx`);
    assert.ok(item.icon, `${item.href} has no icon`);
    assert.ok(nav.includes(`${item.icon}:`), `${item.icon} is not registered`);
    assert.ok(page.includes(`id="${item.id}"`), `${item.href} has no ${item.id} anchor`);
    assert.ok(guide.settings.some((setting) => setting.id === item.id && setting.href === item.href), `${item.href} is absent from the app guide`);
  }
});

test("all account settings and public account pages are reachable from the modal", () => {
  const hrefs = new Set(items.map((item) => item.href));
  const settingsDir = new URL("../app/settings/", import.meta.url);
  for (const entry of fs.readdirSync(settingsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(new URL(`${entry.name}/page.tsx`, settingsDir))) {
      assert.ok(hrefs.has(`/settings/${entry.name}`), `missing settings page: ${entry.name}`);
    }
  }
  for (const href of ["/pricing", "/status", "/changelog", "/legal/terms", "/legal/privacy", "/legal/acceptable-use"]) {
    assert.ok(hrefs.has(href), `missing public account page: ${href}`);
  }
  assert.ok(source("../app/settings/billing/page.tsx").includes("Invoices & receipts"));
});

test("web and API guides match and name only reachable pages and real anchors", () => {
  assert.equal(webGuide, source("../../api/app-guide.json"));
  assert.deepEqual([...new Set(guide.settings.map((item) => item.href))].sort(), items.map((item) => item.href).sort());
  for (const setting of guide.settings) {
    assert.ok(source(`../app${setting.href}/page.tsx`).includes(`id="${setting.id}"`), `missing app-guide anchor: ${setting.id}`);
  }
});
