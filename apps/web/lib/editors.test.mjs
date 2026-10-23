import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./editors.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { editorLink, readEnabledEditors, writeEnabledEditors } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test("editor deep links", () => {
  const repo = "https://github.com/acme/widgets.git";
  assert.equal(editorLink("cursor", repo), "cursor://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets.git");
  assert.equal(editorLink("vscode", repo), "vscode://vscode.git/clone?url=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets.git");
  assert.equal(editorLink("zed", repo), "zed://git/clone?repo=https%3A%2F%2Fgithub.com%2Facme%2Fwidgets.git");
  assert.equal(editorLink("zed", "javascript:alert(1)"), null);
  assert.equal(editorLink("cursor", ""), null);
});

test("enabled editors default to all and honour the saved choice", () => {
  const store = memory();
  assert.deepEqual(readEnabledEditors(store), ["cursor", "vscode", "zed"]);
  writeEnabledEditors(["zed"], store);
  assert.deepEqual(readEnabledEditors(store), ["zed"]);
  writeEnabledEditors([], store);
  assert.deepEqual(readEnabledEditors(store), []);
  store.setItem("teammates-editors", "not json");
  assert.deepEqual(readEnabledEditors(store), ["cursor", "vscode", "zed"]);
});
