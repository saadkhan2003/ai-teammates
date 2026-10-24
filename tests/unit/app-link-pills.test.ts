import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Markdown } from "../../apps/web/components/markdown.tsx";
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
assert.deepEqual(library, { kind: "panel", id: "library", tab: "library", section: "files" });
assert.equal(resolveAppHref("app://panel?tab=coding-jobs")?.tab, "details");
assert.equal(resolveAppHref("app://panel?tab=tasks")?.section, "tasks");
assert.equal(resolveAppHref("app://panel?tab=details")?.tab, "details");
assert.deepEqual(resolveAppHref("app://panel?tab=routines"), { kind: "panel", id: "routines", tab: "library", section: "routines" });
assert.equal(resolveAppHref("app://settings?id=notification-inbox")?.kind, "settings");
assert.equal(resolveAppHref("app://panel?tab=nowhere"), null);
assert.equal(resolveAppHref("app://settings?id=vault")?.kind, "settings");

const view = readFileSync(new URL("../../apps/web/components/markdown.tsx", import.meta.url), "utf8");
assert.match(view, /pillFor\(label, href\)/);
assert.match(view, /data-testid="app-link-pill"/);
assert.match(view, /data-kind=\{pill\.kind\}/);
assert.match(view, /data-target=\{pill\.id\}/);
assert.match(view, /openAppLink\(pill\.href\)/);
assert.match(view, /if \(!pill\.pill\) return <>\{pill\.text\}<\/>/);

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const render = (text: string, jobs: unknown[] = []) => renderToStaticMarkup(React.createElement(Markdown, { text, jobs }));
const appMarkup = render("[Vault](app://settings?id=vault) app://panel?tab=routines [Flux](app://settings?id=missing)");
assert.equal((appMarkup.match(/data-testid="app-link-pill"/g) ?? []).length, 2);
assert.match(appMarkup, /data-target="vault"/);
assert.match(appMarkup, /data-target="routines"/);
assert.match(appMarkup, / Flux</);
assert.doesNotMatch(appMarkup, /id=missing/);
const links = render("[Review](https://github.com/example/repo/pull/6) [File](/api/artifacts/123/download) [Unsafe](javascript:alert)", [{ id: "merge-awareness", prUrl: "https://github.com/example/repo/pull/6", title: "Merge awareness" }]);
assert.match(links, /data-testid="link-preview"/);
assert.match(links, /Merge awareness/);
assert.match(links, /target="_blank"/);
assert.match(links, /href="\/api\/artifacts\/123\/download"/);
assert.doesNotMatch(links, /href="javascript:/);
const code = render("```text\n[Vault](app://settings?id=vault)\n```\n`app://panel?tab=routines`\n**Bold**\n> Quote\n- List\n<img src=x onerror=alert(1)>");
assert.doesNotMatch(code, /data-testid="app-link-pill"/);
assert.match(code, /<pre/);
assert.match(code, /<strong>Bold<\/strong>/);
assert.match(code, /<blockquote/);
assert.match(code, /&lt;img/);

console.log("app link pills, nested navigation, and Markdown union ok");
