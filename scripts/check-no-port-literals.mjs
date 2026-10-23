import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await readFile(path.join(root, 'contracts/box-contract.json')));
const ports = [...new Set([
  ...Object.values(contract.fixedPorts),
  ...Object.values(contract.displayPorts),
  ...Object.values(contract.displayPorts).flatMap(base => Array.from({ length: contract.maxWindows }, (_, i) => base + i + 1))
])];
const allow = new Set((await readFile(path.join(root, 'scripts/port-literal-allowlist.txt'), 'utf8'))
  .split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean));
const roots = ['apps', 'services', 'companion', 'deploy'];
const generated = new Set(['apps/api/BoxContract.g.cs', 'services/computer/src/box_contract.py', 'services/computer/scripts/box-contract.sh', 'apps/web/lib/box-contract.ts']);
const errors = [];
async function walk(dir) {
  for (const ent of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, ent.name);
    if (ent.isDirectory()) await walk(rel);
    else if (!generated.has(rel) && /\.(cs|py|sh|ts|tsx|js|mjs|json|yml|yaml|Dockerfile)$/.test(ent.name)) {
      const lines = (await readFile(path.join(root, rel), 'utf8')).split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const port of ports) if (new RegExp(`(?<![0-9])${port}(?![0-9])`).test(line) && !allow.has(`${rel}:${port}`)) errors.push(`${rel}:${i + 1}: literal port ${port}`);
      });
    }
  }
}
for (const dir of roots) await walk(dir);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
