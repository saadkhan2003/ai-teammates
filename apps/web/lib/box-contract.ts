// @generated sha256:28fb83906ddd44d32cdd516e1f4d1cea713612a93391c207d3bf27686642ef2a
export const MAX_WINDOWS = 8 as const;
export const FIXED_PORTS = {
  "exec": 1337,
  "pty": 1338,
  "windowRouter": 1339,
  "hostGateway": 1340,
  "vncPrimary": 5900,
  "novncPlain": 6080,
  "novncTokened": 6081,
  "egressTunnelWs": 8790,
  "egressProxy": 8791,
  "cdpBase": 9222,
  "externalViewBase": 9400,
  "tailnetChromeCdp": 9600
} as const;
export const BINDS = {
  "exec": "internal",
  "pty": "internal",
  "windowRouter": "internal",
  "hostGateway": "internal",
  "vncPrimary": "loopback",
  "novncPlain": "internal",
  "novncTokened": "internal",
  "egressTunnelWs": "internal",
  "egressProxy": "loopback",
  "cdp": "loopback",
  "externalView": "loopback",
  "tailnetChromeCdp": "loopback"
} as const;
export const SCREEN = {"width":1920,"height":1200} as const;
export const MODEL = {"width":1280,"height":800,"scale":1.5} as const;
export const PATHS = {
  "novncTokens": "/tmp/box-novnc-tokens.d",
  "windowTokens": "/tmp/box-window-tokens.d",
  "windowUsed": "/tmp/box-window-used.d",
  "egressFailClosed": "/tmp/box-egress-fail-closed"
} as const;
const bases = {"vnc":5900,"exec":14000,"pty":13600,"cdp":9222,"externalView":9400} as const;
export type PortKind = keyof typeof bases;
export function portFor(kind: PortKind, display: number): number {
  if (!Number.isInteger(display) || display < 1 || display > MAX_WINDOWS) throw new RangeError("display must be an integer between 1 and MAX_WINDOWS");
  return bases[kind] + display;
}
