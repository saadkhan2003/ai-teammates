import test from "node:test";
import assert from "node:assert/strict";
import { settingsNavGroups } from "../components/settings-nav-data.mjs";

test("settings navigation has unique ids, labels, and destinations", () => {
  const items = settingsNavGroups.flatMap((group) => group.items);
  for (const key of ["id", "label", "href"]) {
    const values = items.map((item) => item[key]).filter(Boolean);
    assert.equal(new Set(values).size, values.length, `duplicate settings navigation ${key}`);
  }
  assert.deepEqual(settingsNavGroups.map((group) => group.heading), ["Account", "Workspace", "Billing", "Support", "System"]);
});
