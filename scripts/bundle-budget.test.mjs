import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { bundleBudget, run } from "./bundle-budget.mjs";

test("app routes inherit layouts and shared runtime exactly once; pages include _app", () => {
  const dir = mkdtempSync(join(tmpdir(), "speed-bundle-"));
  try {
    mkdirSync(join(dir, "static"));
    for (const name of ["runtime", "layout", "nested", "page", "app"]) writeFileSync(join(dir, `static/${name}.js`), `console.log('${name}');`);
    writeFileSync(join(dir, "app-build-manifest.json"), JSON.stringify({ pages: { "/layout": ["static/layout.js"], "/(main)/layout": ["static/nested.js"], "/(main)/bots/[id]/page": ["static/page.js", "static/layout.js"] } }));
    writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/runtime.js"], pages: { "/_app": ["static/app.js"], "/login": ["static/page.js"] } }));
    const result = bundleBudget(dir);
    assert.deepEqual(result["/bots/[id]"].chunks, ["static/layout.js", "static/nested.js", "static/page.js", "static/runtime.js"]);
    assert.equal(result["/login"].chunks.length, 3);
    assert.equal(result["/bots/[id]"].gzip_bytes, ["layout", "nested", "page", "runtime"].reduce((n, name) => n + gzipSync(`console.log('${name}');`, { level: 9 }).length, 0));
  } finally { rmSync(dir, { recursive: true }); }
});
test("enforcement is opt-in and missing build output fails clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "speed-budget-"));
  try {
    assert.throws(() => bundleBudget(dir), /No build manifests/);
    writeFileSync(join(dir, "big.js"), randomBytes(220 * 1024));
    writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ pages: { "/": ["big.js"] } }));
    const args = ["--next", dir, "--out", join(dir, "result.json")];
    assert.equal(run(args), 0);
    assert.equal(run([...args, "--enforce"]), 1);
  } finally { rmSync(dir, { recursive: true }); }
});
