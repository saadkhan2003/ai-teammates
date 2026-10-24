#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const read = path => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const js = paths => paths.filter(p => typeof p === "string" && p.endsWith(".js"));
export function bundleBudget(nextDir) {
  const app = read(join(nextDir, "app-build-manifest.json"));
  const pages = read(join(nextDir, "build-manifest.json"));
  if (!app && !pages) throw new Error(`No build manifests in ${nextDir}; build the web image first`);
  const output = {};
  const common = js([...(pages?.polyfillFiles ?? []), ...(pages?.rootMainFiles ?? [])]);
  const measure = files => {
    const chunks = [...new Set(files)].sort();
    // gzip per resource matches transferred JS; summing compressed sizes preserves resource boundaries.
    const gzip_bytes = chunks.reduce((n, file) => n + gzipSync(readFileSync(join(nextDir, file)), { level: 9 }).length, 0);
    return { gzip_kb: gzip_bytes / 1024, gzip_bytes, chunks };
  };
  for (const [route, files] of Object.entries(pages?.pages ?? {})) {
    if (["/_app", "/_document"].includes(route)) continue;
    output[route] = measure(js([...common, ...(pages.pages["/_app"] ?? []), ...files]));
  }
  const appPages = app?.pages ?? {};
  for (const [entry, files] of Object.entries(appPages)) {
    if (!entry.endsWith("/page")) continue;
    // App manifests list entry chunks separately: include all enclosing layouts, including root.
    const parts = entry.split("/").filter(Boolean);
    const inherited = [];
    for (let depth = 0; depth < parts.length; depth++) inherited.push(...(appPages["/" + [...parts.slice(0, depth), "layout"].join("/")] ?? []));
    const route = "/" + parts.slice(0, -1).filter(p => !/^\([^)]*\)$/.test(p) && !p.startsWith("@")).join("/");
    const chunks = js([...common, ...inherited, ...files, ...(output[route]?.chunks ?? [])]);
    output[route] = measure(chunks);
  }
  if (!Object.keys(output).length) throw new Error("No route entries found in build manifests");
  return output;
}
export function run(args = process.argv.slice(2)) {
  const option = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback; };
  const nextDir = resolve(option("--next", "apps/web/.next"));
  const destination = resolve(option("--out", "test-results/bundle-budget.json"));
  const routes = bundleBudget(nextDir);
  console.table(Object.entries(routes).map(([route, result]) => ({ route, "first-load gzip KB": result.gzip_kb.toFixed(2), budget: 200, pass: result.gzip_kb <= 200 })));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify({ generated_at: new Date().toISOString(), budget_kb: 200, routes }, null, 2) + "\n");
  return args.includes("--enforce") && Object.values(routes).some(r => r.gzip_kb > 200) ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
