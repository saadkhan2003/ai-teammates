import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pillFor, resolveAppHref } from "../../apps/web/lib/app-links.ts";

const vault = pillFor("Vault", "app://settings?id=vault");
assert.equal(vault.pill, true);
if (vault.pill) {
  assert.equal(vault.kind, "settings");
  assert.equal(vault.id, "vault");
  assert.equal(vault.label, "Vault");
}

const missing = pillFor("Flux", "app://settings?id=not-a-real-setting");
assert.deepEqual(missing, { pill: false, text: "Flux" });

const library = resolveAppHref("app://panel?tab=library");
assert.deepEqual(library, { kind: "panel", id: "library", tab: "files" });
assert.equal(resolveAppHref("app://panel?tab=coding-jobs")?.tab, "tasks");
assert.equal(resolveAppHref("app://panel?tab=details")?.tab, "overview");
assert.equal(resolveAppHref("app://panel?tab=nowhere"), null);
assert.equal(resolveAppHref("app://settings?id=vault")?.kind, "settings");

const view = readFileSync(new URL("../../apps/web/components/markdown.tsx", import.meta.url), "utf8");
assert.match(view, /pillFor\(label, href\)/);
assert.match(view, /data-testid="app-link-pill"/);
assert.match(view, /data-kind=\{pill\.kind\}/);
assert.match(view, /data-target=\{pill\.id\}/);
assert.match(view, /openAppLink\(pill\.href\)/);
assert.match(view, /if \(!pill\.pill\) return <>\{pill\.text\}<\/>/);

console.log("app link pills ok");
