import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const ts = webRequire("typescript");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = new URL(`../../apps/web/${specifier.slice(2)}`, import.meta.url).href;
    if (/\.[a-z]+$/i.test(base)) return nextResolve(base, context);
    try { return await nextResolve(`${base}.ts`, context); }
    catch { return nextResolve(`${base}.tsx`, context); }
  }
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (/\.tsx?$/.test(url)) {
    const source = await readFile(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
        fileName: new URL(url).pathname,
      }).outputText,
    };
  }
  return nextLoad(url, context);
}
