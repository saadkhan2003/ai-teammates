import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await mkdtemp(path.join(tmpdir(), 'box-contract-'));
try {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/gen-box-contract.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const contract = JSON.parse(await readFile(path.join(root, 'contracts/box-contract.json'), 'utf8'));
  for (const relative of ['apps/api/BoxContract.g.cs', 'services/computer/src/box_contract.py', 'services/computer/scripts/box-contract.sh', 'apps/web/lib/box-contract.ts']) {
    assert.match(await readFile(path.join(out, relative), 'utf8'), /@generated sha256:[a-f0-9]{64}/);
  }
  const shell = path.join(out, 'services/computer/scripts/box-contract.sh');
  for (let display = 1; display <= contract.maxWindows; display++) {
    for (const [kind, base] of Object.entries(contract.displayPorts)) {
      const got = spawnSync('bash', ['-c', `source "$1"; box_port_for "$2" "$3"`, 'test', shell, kind, String(display)], { encoding: 'utf8' });
      assert.equal(got.status, 0, got.stderr);
      const expected = { vnc: 5900 + display, exec: 14000 + display, pty: 13600 + display, cdp: 9222 + display, externalView: 9400 + display };
      assert.equal(Number(got.stdout.trim()), expected[kind]);
      assert.equal(base + display, expected[kind]);
    }
  }
} finally {
  await rm(out, { recursive: true, force: true });
}
