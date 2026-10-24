import assert from "node:assert/strict";
import test from "node:test";
import { loadBrandIcon } from "./brand-icons";
import { actionLabel, catalogOrFallback, connectSections, connectorLine, isConnected, readCatalogApps, readInstalledApps, toolCountFromManifest } from "./connect-apps";

test("catalog rows keep description, category, and tool count", () => {
  const parsed = readCatalogApps({
    items: [
      { id: "notion", name: "Notion", category: "Productivity", authType: "none", description: "Search Notion pages", toolCount: 2, trust: "official" },
      { id: "github", name: "GitHub", category: "Code", authType: "oauth", manifest: { tools: [{ description: "Pull requests" }] } },
    ],
    categories: ["Productivity", "Code"],
    total: 2,
  });
  assert.equal(parsed.items[0]?.description, "Search Notion pages");
  assert.equal(parsed.items[1]?.description, "Pull requests");
  assert.equal(parsed.items[1]?.toolCount, 1);
  assert.equal(parsed.items[1]?.authType, "oauth");
});

test("sections follow the catalog categories and recommend flagged apps", () => {
  const items = readCatalogApps({
    items: [
      { id: "notion", name: "Notion", category: "Productivity", trust: "official", description: "Pages" },
      { id: "stripe", name: "Stripe", category: "Finance", description: "Payments" },
      { id: "github", name: "GitHub", category: "Code", authType: "oauth", description: "Repos" },
    ],
  }).items;
  const titles = connectSections(items, "All").map((section) => section.title);
  assert.deepEqual(titles, ["Recommended for you", "Productivity", "Code", "Finance"]);
  assert.equal(connectSections(items, "Code")[0]?.items[0]?.name, "GitHub");
  assert.equal(actionLabel("oauth"), "Connect");
  assert.equal(actionLabel("none"), "Add");
});

test("an empty registry still offers three recommended apps", () => {
  const picks = catalogOrFallback([]);
  assert.equal(picks.length, 3);
  assert.deepEqual(picks.map((item) => item.name), ["Notion", "Slack", "Gmail"]);
  assert.equal(catalogOrFallback([{ id: "x", name: "Linear", description: "", category: "Code", authType: "none", kind: "builtin", publisher: "", trust: "official", label: "tested", blocked: false, toolCount: 0, iconUrl: "" }]).length, 1);
});

test("known brands resolve to bundled simple-icons marks", async () => {
  const notion = await loadBrandIcon("Notion");
  assert.equal(notion?.hex.toLowerCase(), "000000");
  const drive = await loadBrandIcon("Google Drive");
  assert.equal(drive?.title, "Google Drive");
  assert.equal(await loadBrandIcon("Zz No Such Brand 9911"), null);
});

test("catalog icon urls are kept when they are real addresses", () => {
  const parsed = readCatalogApps({ items: [{ id: "custom", name: "Custom", iconUrl: "https://cdn.example/icon.png", category: "Code" }] });
  assert.equal(parsed.items[0]?.iconUrl, "https://cdn.example/icon.png");
  const local = readCatalogApps({ items: [{ id: "plain", name: "Plain", icon: "not-a-url" }] });
  assert.equal(local.items[0]?.iconUrl, "");
});

test("installed apps count tools in the manifest and report a connection", () => {
  const rows = readInstalledApps([
    { id: "gmail", name: "Gmail", auth_type: "oauth", secret_id: "sec", manifest: JSON.stringify({ tools: [{ name: "send" }] }) },
    { id: "plain", name: "Plain", authType: "none", status: "installed" },
  ]);
  assert.equal(rows[0]?.toolCount, 1);
  assert.equal(connectorLine(1), "1 connector, 1 skill");
  assert.equal(isConnected(rows[0]!), true);
  assert.equal(isConnected(rows[1]!), true);
  assert.equal(toolCountFromManifest("{}"), 0);
});
