import assert from "node:assert/strict";
import test from "node:test";
import { settingsGroups } from "../components/settings-nav-config.mjs";

test("settings navigation has unique ids, labels, and destinations across groups", () => {
  const items = settingsGroups.flatMap((group) => group.items);
  for (const key of ["id", "label", "href"]) {
    const values = items.map((item) => item[key]);
    assert.equal(new Set(values).size, values.length, `duplicate settings ${key}`);
  }
  assert.deepEqual(settingsGroups.map((group) => group.heading), ["Account", "Workspace", "Billing", "Support", "System"]);
  assert.equal(settingsGroups.find((group) => group.heading === "Workspace").items.some((item) => item.id === "skills"), true);
  assert.equal(settingsGroups.find((group) => group.heading === "Billing").items.length, 1);
});
