import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { settingsGroups } from "../components/settings-nav-config.mjs";

test("settings navigation has unique ids, labels, and destinations across groups", () => {
  const items = settingsGroups.flatMap((group) => group.items);
  for (const key of ["id", "label", "href"]) {
    const values = items.map((item) => item[key]);
    assert.equal(new Set(values).size, values.length, `duplicate settings ${key}`);
  }
  assert.deepEqual(settingsGroups.map((group) => group.heading), ["Preferences", "Workspace", "Staff"]);
  assert.equal(settingsGroups.find((group) => group.heading === "Workspace").items.some((item) => item.id === "skills"), true);
  assert.equal(items.filter((item) => item.admin).map((item) => item.id).join(), "system");
});

test("every settings destination has a route", () => {
  for (const item of settingsGroups.flatMap((group) => group.items)) {
    const dir = new URL(`../app${item.href}/page.tsx`, import.meta.url);
    assert.equal(fs.existsSync(dir), true, `${item.href} has no page`);
  }
});
