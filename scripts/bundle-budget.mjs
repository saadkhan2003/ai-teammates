import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.resolve(process.argv[2] ?? "apps/web/.next");
const target = Number(process.env.BUNDLE_BUDGET_GZIP_BYTES ?? 200 * 1024);
const manifestPath = ["server/app-build-manifest.json", "app-build-manifest.json", "build/app-build-manifest.json"].map(p => path.join(root, p)).find(fs.existsSync);
const legacyPath = ["build-manifest.json", "server/build-manifest.json", "build/build-manifest.json"].map(p => path.join(root, p)).find(fs.existsSync);
if (!manifestPath && !legacyPath) {
  console.error(`Missing Next build manifest under ${root}; run after the web build.`);
  process.exit(2);
}
const app = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const legacy = fs.existsSync(legacyPath) ? JSON.parse(fs.readFileSync(legacyPath, "utf8")) : null;
const routeFiles = new Map();
if (app?.pages) for (const [route, files] of Object.entries(app.pages)) routeFiles.set(route, new Set([...(app.rootMainFiles ?? []), ...files]));
if (legacy?.pages) for (const [route, files] of Object.entries(legacy.pages)) {
  const set = routeFiles.get(route) ?? new Set(); for (const file of files) set.add(file); routeFiles.set(route, set);
}
for (const [route, files] of routeFiles) {
  let bytes = 0;
  for (const file of files) {
    const full = path.join(root, file);
    if (fs.existsSync(full) && /\.js$/.test(file)) bytes += gzipSync(fs.readFileSync(full)).byteLength;
  }
  console.log(`${route}: ${bytes} gzip bytes`);
  if (bytes >= target) process.exitCode = 1;
}
