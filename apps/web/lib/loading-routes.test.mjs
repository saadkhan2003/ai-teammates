import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function routeDirs(root) {
  const found = [];
  const visit = dir => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === "page.tsx")) found.push(dir);
    for (const entry of entries) if (entry.isDirectory()) visit(join(dir, entry.name));
  };
  visit(root);
  return found;
}

test("every web and admin page route has a segment loading boundary", () => {
  for (const app of ["web", "admin"]) {
    const root = join(repo, "apps", app, "app");
    for (const dir of routeDirs(root)) {
      assert.ok(existsSync(join(dir, "loading.tsx")), `${dir} needs loading.tsx`);
    }
  }
});
