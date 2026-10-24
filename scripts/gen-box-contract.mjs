import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--out');
const out = arg < 0 ? root : path.resolve(process.argv[arg + 1]);
const source = await readFile(path.join(root, 'contracts/box-contract.json'));
const c = JSON.parse(source);
const hash = createHash('sha256').update(source).digest('hex');
const header = (line) => `${line} @generated sha256:${hash}\n`;
const kinds = Object.entries(c.displayPorts);
const fixed = Object.entries(c.fixedPorts);
const paths = Object.entries(c.paths);
const binds = Object.entries(c.binds);
const py = `${header('#')}from __future__ import annotations\n\nMAX_WINDOWS = ${c.maxWindows}\n${fixed.map(([k,v]) => `${k.replace(/[A-Z]/g, x => `_${x.toLowerCase()}`).toUpperCase()} = ${v}`).join('\n')}\nSCREEN = ${JSON.stringify(c.screen)}\nMODEL = ${JSON.stringify(c.model)}\nPATHS = ${JSON.stringify(c.paths)}\nBINDS = ${JSON.stringify(c.binds)}\n\ndef port_for(kind: str, display: int) -> int:\n    if isinstance(display, bool) or not isinstance(display, int) or not 1 <= display <= MAX_WINDOWS:\n        raise ValueError("display must be an integer between 1 and MAX_WINDOWS")\n    bases = ${JSON.stringify(c.displayPorts)}\n    try:\n        return bases[kind] + display\n    except KeyError as exc:\n        raise ValueError("unknown port kind") from exc\n`;
const csName = (s) => s[0].toUpperCase() + s.slice(1);
const cs = `${header('//')}namespace Teammates.Api;\n\npublic static class BoxContract\n{\n    public const int MaxWindows = ${c.maxWindows};\n${fixed.map(([k,v]) => `    public const int ${csName(k)} = ${v};`).join('\n')}\n    public const int ScreenWidth = ${c.screen.width};\n    public const int ScreenHeight = ${c.screen.height};\n    public const int ModelWidth = ${c.model.width};\n    public const int ModelHeight = ${c.model.height};\n    public const double ModelScale = ${c.model.scale};\n${paths.map(([k,v]) => `    public const string ${csName(k)}Path = "${v}";`).join('\n')}\n    public static int PortFor(string kind, int display)\n    {\n        if (display < 1 || display > MaxWindows) throw new ArgumentOutOfRangeException(nameof(display));\n        var basis = kind switch\n        {\n${kinds.map(([k,v]) => `            "${k}" => ${v},`).join('\n')}\n            _ => throw new ArgumentException("Unknown port kind", nameof(kind))\n        };\n        return basis + display;\n    }\n}\n`;
const ts = `${header('//')}export const MAX_WINDOWS = ${c.maxWindows} as const;\nexport const FIXED_PORTS = ${JSON.stringify(c.fixedPorts, null, 2)} as const;\nexport const BINDS = ${JSON.stringify(c.binds, null, 2)} as const;\nexport const SCREEN = ${JSON.stringify(c.screen)} as const;\nexport const MODEL = ${JSON.stringify(c.model)} as const;\nexport const PATHS = ${JSON.stringify(c.paths, null, 2)} as const;\nconst bases = ${JSON.stringify(c.displayPorts)} as const;\nexport type PortKind = keyof typeof bases;\nexport function portFor(kind: PortKind, display: number): number {\n  if (!Number.isInteger(display) || display < 1 || display > MAX_WINDOWS) throw new RangeError("display must be an integer between 1 and MAX_WINDOWS");\n  return bases[kind] + display;\n}\n`;
const sh = `${header('#')}MAX_WINDOWS=${c.maxWindows}\nbox_port_for() {\n  local kind="$1" display="$2" base\n  case "$display" in ''|*[!0-9]*) return 2 ;; esac\n  if (( display < 1 || display > MAX_WINDOWS )); then return 2; fi\n  case "$kind" in\n${kinds.map(([k,v]) => `    ${k}) base=${v} ;;`).join('\n')}\n    *) return 2 ;;\n  esac\n  printf '%s\\n' "$((base + display))"\n}\n`;
const outputs = new Map([
 ['apps/api/BoxContract.g.cs', cs], ['services/computer/src/box_contract.py', py],
 ['services/computer/scripts/box-contract.sh', sh], ['apps/web/lib/box-contract.ts', ts]
]);
for (const [file, content] of outputs) {
 const target = path.join(out, file);
 await mkdir(path.dirname(target), { recursive: true });
 await writeFile(target, content);
}
