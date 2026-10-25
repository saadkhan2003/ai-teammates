"use client";

import { computerVideoProgress } from "@/lib/computer-video-state";
import type { AgentEvent } from "@/lib/events";
import { VideoProgress } from "@/components/video-progress";
import { Eye, MousePointer2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ReactNode } from "react";
import { ComputerState, DisplayDots, type ComputerPhase } from "@/components/computer-preview-state";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { ComputerJobs } from "@/components/computer-jobs";
import { api, readDesktopToken } from "@/lib/api";
import { controlActionLabel } from "@/lib/chat-ui";
import type { BrowserPage, Task } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

type VncState = "connected" | "disconnected" | "control-disconnected";
type DesktopMode = "view" | "control";

type RfbClient = {
  scaleViewport: boolean;
  showDotCursor: boolean;
  viewOnly: boolean;
  background: string;
  disconnect: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  sendKey: (keysym: number, code?: string, down?: boolean) => void;
};

function keysymFor(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 0x20) return null;
  return code < 0x100 ? code : 0x01000000 + code;
}

function socketUrl(token: string, windowId: string) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/vnc/websockify?token=${encodeURIComponent(token)}&window=${encodeURIComponent(windowId)}`;
}

function statusLabel(state: VncState) {
  if (state === "connected") return "Connected";
  if (state === "control-disconnected") return "Control disconnected";
  return "Disconnected";
}

const MAX_VIEW_RECONNECTS = 6;
const socketSettled = new WeakSet<RfbClient>();
let activeSocket: RfbClient | null = null;
let socketChain: Promise<void> = Promise.resolve();

function enqueueSocket(task: () => Promise<void>): Promise<void> {
  const run = socketChain.then(task, task);
  socketChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function settleSocket(rfb: RfbClient) {
  socketSettled.add(rfb);
  if (activeSocket === rfb) activeSocket = null;
}

function browserSocket(rfb: RfbClient): WebSocket | null {
  const sock = (rfb as unknown as { _sock?: { _websocket?: WebSocket } })._sock;
  return sock?._websocket ?? null;
}

function releaseSocket(rfb: RfbClient | null): Promise<void> {
  if (!rfb || socketSettled.has(rfb)) {
    if (rfb && activeSocket === rfb) activeSocket = null;
    return Promise.resolve();
  }
  if (activeSocket === rfb) activeSocket = null;
  const ws = browserSocket(rfb);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      settleSocket(rfb);
      resolve();
    };
    // noVNC can report disconnect after 3s while the browser socket is still
    // CLOSING. Wait for the actual close so the next pane cannot open a second one.
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.addEventListener("close", finish, { once: true });
    }
    try {
      rfb.addEventListener("disconnect", () => {
        if (!ws || ws.readyState === WebSocket.CLOSED) finish();
      });
    } catch {
      finish();
      return;
    }
    try {
      rfb.disconnect();
    } catch {
      finish();
      return;
    }
    if (ws?.readyState === WebSocket.CLOSED) finish();
    window.setTimeout(finish, 8000);
  });
}

function desktopTabId(): string {
  const key = "teammates.desktop.tab";
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(key, value);
  }
  return value;
}

export function ComputerPane({
  botId,
  tasks,
  events = [],
  pages,
  holder,
  onChanged,
  compact = false,
  caption,
  avatarShape,
  avatarColor,
  avatar,
  displays = 1,
  fullscreen: fullscreenProp = false,
  onExpand,
  onExitFullscreen,
  recording = false,
  autoControlKey = 0,
  handBackKey = 0,
  onHandedBack,
}: {
  botId: string;
  tasks: Task[];
  events?: AgentEvent[];
  pages: BrowserPage[];
  holder: "agent" | "human";
  onChanged: () => void;
  compact?: boolean;
  caption?: string;
  avatarShape?: string;
  avatarColor?: string;
  avatar?: ReactNode;
  displays?: number;
  fullscreen?: boolean;
  onExpand?: () => void;
  onExitFullscreen?: () => void;
  recording?: boolean;
  /** Bumping this number takes control of the desktop (used when teaching a task). */
  autoControlKey?: number;
  /** Bumping this number hands control back when this pane currently holds it. */
  handBackKey?: number;
  onHandedBack?: () => void;
}) {
  // Leaving the full view plays a short fade-and-shrink before the panel layout comes back.
  const [exiting, setExiting] = useState(false);
  const wasFull = useRef(fullscreenProp);
  useEffect(() => {
    const was = wasFull.current;
    wasFull.current = fullscreenProp;
    if (fullscreenProp) { setExiting(false); return; }
    if (!was || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setExiting(true);
    const timer = window.setTimeout(() => setExiting(false), 200);
    return () => window.clearTimeout(timer);
  }, [fullscreenProp]);
  const fullscreen = fullscreenProp || exiting;
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const sessionRef = useRef(0);
  const leaseEpoch = useRef(0);
  const modeRef = useRef<DesktopMode>("view");
  const ignoreRef = useRef(new Set<number>());
  const connectGen = useRef(0);
  const liveRef = useRef(false);
  const openingRef = useRef(false);
  const pendingRef = useRef(false);
  const wantViewRef = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const botIdRef = useRef(botId);
  const compactRef = useRef(compact);
  const fullscreenRef = useRef(fullscreen);
  const expandRef = useRef(onExpand);
  compactRef.current = compact;
  fullscreenRef.current = fullscreen;
  expandRef.current = onExpand;
  const mobileRef = useRef(false);
  const armedControl = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [collapsedView, setCollapsedView] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const keyValue = useRef("");
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  botIdRef.current = botId;

  const [vncState, setVncState] = useState<VncState>("disconnected");
  const [mode, setMode] = useState<DesktopMode>("view");
  const [error, setError] = useState<string | null>(null);
  const [connectFailed, setConnectFailed] = useState(false);
  const [desktopAsleep, setDesktopAsleep] = useState(false);
  const wakeRequested = useRef(false);
  // Opening the full computer view is an explicit "show me the screen", so it wakes the desktop.
  const fullViewRef = useRef(fullscreenProp);
  fullViewRef.current = fullscreenProp;
  const [busy, setBusy] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [online, setOnline] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [keyboard, setKeyboard] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);
  const [power, setPower] = useState<string>("unknown");
  zoomRef.current = zoom;
  panRef.current = pan;
  const desktopSessionBot = useRef<string | null>(null);
  const videoProgress = computerVideoProgress(tasks, events, desktopSessionBot.current === botId || holder === "human" || mode === "control");
  const videoOnly = videoProgress !== null;
  const videoOnlyRef = useRef(videoOnly);
  videoOnlyRef.current = videoOnly;
  const waiting = tasks.filter((task) => task.status === "waiting_human");

  function clearReconnect() {
    if (reconnectTimer.current != null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }

  function scheduleViewReconnect() {
    if (!wantViewRef.current || reconnectTimer.current != null || modeRef.current === "control") return;
    if (reconnectAttempt.current >= MAX_VIEW_RECONNECTS) return;
    const attempt = reconnectAttempt.current;
    reconnectAttempt.current += 1;
    const delay = Math.min(8000, 400 * 2 ** attempt);
    reconnectTimer.current = window.setTimeout(() => {
      reconnectTimer.current = null;
      if (!wantViewRef.current || modeRef.current === "control") return;
      void startView();
    }, delay);
  }

  async function openSocket(token: string, nextMode: DesktopMode, gen: number) {
    if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
    const imported = await import("@novnc/novnc/lib/rfb.js");
    if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
    const screen = screenRef.current;
    if (!screen || !token) throw new Error("The desktop session did not include a token.");
    screen.replaceChildren();
    const session = ++sessionRef.current;
    const RFB = imported.default;
    const rfb = new RFB(screen, socketUrl(token, botIdRef.current)) as unknown as RfbClient;
    const resolved: DesktopMode = mobileRef.current && nextMode === "control" && !armedControl.current ? "view" : nextMode;
    rfb.scaleViewport = true;
    rfb.showDotCursor = true;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue("--computer-background").trim();
    rfb.viewOnly = resolved !== "control";
    modeRef.current = resolved;
    setMode(resolved);
    activeSocket = rfb;
    rfbRef.current = rfb;
    liveRef.current = false;
    openingRef.current = true;
    rfb.addEventListener("connect", () => {
      if (session !== sessionRef.current) return;
      liveRef.current = true;
      openingRef.current = false;
      reconnectAttempt.current = 0;
      clearReconnect();
      setVncState("connected");
      setError(null);
    });
    rfb.addEventListener("disconnect", () => {
      settleSocket(rfb);
      openingRef.current = false;
      if (ignoreRef.current.has(session)) {
        ignoreRef.current.delete(session);
        if (rfbRef.current === rfb) rfbRef.current = null;
        return;
      }
      if (session !== sessionRef.current) return;
      liveRef.current = false;
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (!wantViewRef.current) {
        setVncState("disconnected");
        return;
      }
      if (modeRef.current === "control") {
        setVncState("control-disconnected");
        return;
      }
      setVncState("disconnected");
      scheduleViewReconnect();
    });
  }

  async function openView(nextMode: DesktopMode, path: string, gen: number) {
    await enqueueSocket(async () => {
      if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
      if (activeSocket || rfbRef.current) {
        ignoreRef.current.add(sessionRef.current);
        const previous = activeSocket ?? rfbRef.current;
        rfbRef.current = null;
        liveRef.current = false;
        openingRef.current = false;
        await releaseSocket(previous);
      }
      if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
      const raw = await api<unknown>(path, { method: "POST", headers: { "X-Desktop-Tab": desktopTabId() } });
      if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
      const token = readDesktopToken(raw);
      if (typeof token.epoch === "number") leaseEpoch.current = token.epoch;
      const mode = token.mode === "control" ? "control" : nextMode;
      await openSocket(token.token, mode, gen);
    });
  }

  // Headless computers: the desktop only starts for browser or desktop work, Watch or Take
  // control. Opening the panel checks first and shows "Desktop asleep" instead of waking it.
  async function desktopIsAsleep(): Promise<boolean> {
    try {
      const state = await api<{ desktop?: string }>("/api/computer/desktop");
      // "unknown" means the computer did not answer the probe in time; rest on Watch rather than waking it.
      return state?.desktop === "asleep" || state?.desktop === "unknown";
    } catch {
      return true;
    }
  }

  async function startView(force = false) {
    if (!wantViewRef.current || videoOnlyRef.current) return;
    if (liveRef.current || openingRef.current || pendingRef.current) return;
    pendingRef.current = true;
    clearReconnect();
    const gen = ++connectGen.current;
    setError(null);
    if (!force && !wakeRequested.current && !fullViewRef.current && (await desktopIsAsleep())) {
      if (gen === connectGen.current) {
        pendingRef.current = false;
        setConnecting(false);
        setConnectFailed(false);
        setDesktopAsleep(true);
      }
      return;
    }
    if (gen !== connectGen.current || !wantViewRef.current) {
      pendingRef.current = false;
      return;
    }
    setDesktopAsleep(false);
    setConnecting(true);
    try {
      await openView("view", `/api/computers/${botIdRef.current}/vnc-ticket?role=watch`, gen);
    } catch (caught) {
      if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
      liveRef.current = false;
      openingRef.current = false;
      setVncState("disconnected");
      setConnecting(false);
      setConnectFailed(true);
      setError(errorMessage(caught, "Could not open the desktop."));
      scheduleViewReconnect();
    } finally {
      if (gen === connectGen.current) pendingRef.current = false;
    }
  }

  function closePaneSocket() {
    wantViewRef.current = false;
    pendingRef.current = false;
    openingRef.current = false;
    liveRef.current = false;
    connectGen.current += 1;
    clearReconnect();
    reconnectAttempt.current = 0;
    ignoreRef.current.add(sessionRef.current);
    const closing = activeSocket ?? rfbRef.current;
    rfbRef.current = null;
    void enqueueSocket(() => releaseSocket(closing));
  }

  useEffect(() => {
    const onChange = () => setNativeFs(!!document.fullscreenElement && (document.fullscreenElement === stageRef.current || document.fullscreenElement === rootRef.current));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const rfb = rfbRef.current;
      if (!rfb) return;
      rfb.scaleViewport = true;
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [videoOnly]);

  useEffect(() => {
    mobileRef.current = window.matchMedia("(max-width: 767px)").matches;
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = () => {
      mobileRef.current = query.matches;
    };
    query.addEventListener("change", onChange);
    wantViewRef.current = !videoOnly;
    if (videoOnly) {
      setError(null);
      setConnectFailed(false);
      setConnecting(false);
    } else void startView();
    return () => {
      query.removeEventListener("change", onChange);
      closePaneSocket();
    };
    // Reconnect when the bot changes. Cleanup closes the previous socket first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, videoOnly]);

  useEffect(() => {
    if (vncState === "connected") { desktopSessionBot.current = botId; setConnecting(false); setConnectFailed(false); setDesktopAsleep(false); wakeRequested.current = false; }
  }, [vncState]);

  // While the desktop sleeps, look again every few seconds; connect once a task wakes it.
  useEffect(() => {
    if (!desktopAsleep) return;
    const timer = window.setInterval(() => {
      if (!wantViewRef.current || document.visibilityState !== "visible") return;
      void desktopIsAsleep().then((asleep) => {
        if (asleep || !wantViewRef.current) return;
        setDesktopAsleep(false);
        void startView();
      });
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopAsleep]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  const phase: ComputerPhase = !online ? "offline" : vncState === "connected" ? "live" : desktopAsleep ? "desktop-asleep" : error || connectFailed ? "error" : connecting ? "connecting" : "sleeping";

  function retryConnect() {
    wantViewRef.current = true;
    reconnectAttempt.current = 0;
    clearReconnect();
    // Watch: this is the one panel action that starts a sleeping desktop.
    wakeRequested.current = true;
    setDesktopAsleep(false);
    void startView(true);
  }

  const paneOpened = useRef(false);
  useEffect(() => {
    const expanded = fullscreen || !compact;
    if (!paneOpened.current) {
      paneOpened.current = true;
      return;
    }
    // The Computer tab and the compact preview share this pane. Switching tabs
    // must not open a second websocket. Reconnect only after the previous one
    // has dropped, and only while the pane is still on screen.
    if (!wantViewRef.current || liveRef.current || openingRef.current || pendingRef.current) return;
    if (expanded) reconnectAttempt.current = 0;
    void startView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, fullscreen]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") closePaneSocket();
    };
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      wantViewRef.current = !videoOnlyRef.current;
      reconnectAttempt.current = 0;
      void startView();
    };
    document.addEventListener("visibilitychange", onHide);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("visibilitychange", onShow);
    };
    // The browser tab is not the info-pane tab. Hiding this document closes the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  async function takeControl() {
    clearReconnect();
    setBusy("control");
    setError(null);
    armedControl.current = true;
    wantViewRef.current = true;
    pendingRef.current = true;
    const gen = ++connectGen.current;
    try {
      await openView("control", `/api/computers/${botId}/vnc-ticket?role=control&transfer=true`, gen);
      if (gen === connectGen.current) onChanged();
    } catch (caught) {
      if (gen === connectGen.current) setError(errorMessage(caught, "Could not take control."));
    } finally {
      if (gen === connectGen.current) pendingRef.current = false;
      setBusy(null);
    }
  }

  useEffect(() => {
    if (mode !== "control") return;
    const timer = window.setInterval(() => {
      void api(`/api/computers/${botId}/lease`, { method: "POST", body: JSON.stringify({ action: "heartbeat", tabId: desktopTabId(), epoch: leaseEpoch.current }) }).then((result) => {
        const value = result as { epoch?: unknown };
        if (typeof value?.epoch === "number") leaseEpoch.current = value.epoch;
      }).catch(() => {
        setError("The control lease expired. Take control again to continue.");
      });
    }, 10_000 + Math.floor(Math.random() * 1000));
    return () => window.clearInterval(timer);
  }, [botId, mode]);

  const autoKey = useRef(autoControlKey);
  useEffect(() => {
    if (autoControlKey === autoKey.current) return;
    autoKey.current = autoControlKey;
    if (autoControlKey > 0) void takeControl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoControlKey]);

  const handBackKeyRef = useRef(handBackKey);
  useEffect(() => {
    if (handBackKey === handBackKeyRef.current) return;
    handBackKeyRef.current = handBackKey;
    if (handBackKey > 0 && modeRef.current === "control") void handBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handBackKey]);

  function place(nextZoom: number, nextPan: { x: number; y: number }) {
    const frame = frameRef.current;
    const zoomed = Math.min(4, Math.max(1, nextZoom));
    let x = nextPan.x;
    let y = nextPan.y;
    if (frame) {
      const minX = frame.clientWidth * (1 - zoomed);
      const minY = frame.clientHeight * (1 - zoomed);
      x = Math.min(0, Math.max(minX, x));
      y = Math.min(0, Math.max(minY, y));
    }
    if (zoomed === 1) {
      x = 0;
      y = 0;
    }
    setZoom(zoomed);
    setPan({ x, y });
  }

  function fitWidth() {
    place(1, { x: 0, y: 0 });
  }

  async function toggleFullscreen() {
    const node = fullscreenRef.current ? rootRef.current : stageRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch (caught) {
      setError(errorMessage(caught, "Could not change full screen."));
    }
  }

  function sendChars(text: string) {
    const rfb = rfbRef.current;
    if (!rfb || modeRef.current !== "control") return;
    for (const char of text) {
      const keysym = keysymFor(char);
      if (keysym == null) continue;
      rfb.sendKey(keysym, "Unidentified");
    }
  }

  function sendSpecial(keysym: number) {
    rfbRef.current?.sendKey(keysym, "Unidentified");
  }

  function onKeyboard(value: string) {
    const previous = keyValue.current;
    if (value.startsWith(previous)) sendChars(value.slice(previous.length));
    else if (previous.startsWith(value)) {
      for (let i = 0; i < previous.length - value.length; i++) sendSpecial(0xff08);
    } else {
      sendChars(value);
    }
    keyValue.current = value;
  }

  function toggleKeyboard() {
    if (modeRef.current !== "control") {
      setError("Take control before using the keyboard.");
      return;
    }
    setError(null);
    setKeyboard((open) => {
      const next = !open;
      if (next) window.setTimeout(() => keyRef.current?.focus(), 0);
      return next;
    });
  }

  useEffect(() => {
    let live = true;
    async function loadPower() {
      try {
        const body = await api<{ status?: string }>(`/api/bots/${botId}/computer/power`);
        if (live) setPower((body.status ?? "unknown").toLowerCase());
      } catch {
        if (live) setPower("unknown");
      }
    }
    void loadPower();
    const timer = window.setInterval(() => void loadPower(), 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [botId]);

  async function wake() {
    setBusy("wake");
    try {
      await api(`/api/bots/${botId}/computer/wake`, { method: "POST" });
      setPower("running");
      retryConnect();
      onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught, "Could not wake the computer."));
    } finally {
      setBusy(null);
    }
  }

  async function handBack() {
    clearReconnect();
    setBusy("hand");
    setError(null);
    armedControl.current = false;
    setKeyboard(false);
    const gen = ++connectGen.current;
    pendingRef.current = true;
    try {
      await api(`/api/bots/${botId}/computer/hand-back`, { method: "POST", body: JSON.stringify({ tabId: desktopTabId(), epoch: leaseEpoch.current }) });
      ignoreRef.current.add(sessionRef.current);
      const closing = activeSocket ?? rfbRef.current;
      rfbRef.current = null;
      liveRef.current = false;
      openingRef.current = false;
      modeRef.current = "view";
      await enqueueSocket(() => releaseSocket(closing));
      if (gen !== connectGen.current || !wantViewRef.current || videoOnlyRef.current) return;
      pendingRef.current = false;
      reconnectAttempt.current = 0;
      setVncState("disconnected");
      await startView();
      onChanged();
      onHandedBack?.();
    } catch (caught) {
      setError(errorMessage(caught, "Could not hand the computer back."));
    } finally {
      if (gen === connectGen.current) pendingRef.current = false;
      setBusy(null);
    }
  }

  async function forceRelease() {
    const reason = window.prompt("Reason for releasing this desktop lease:")?.trim();
    if (!reason) return;
    setBusy("force-release");
    setError(null);
    try {
      await api(`/api/computers/${botId}/lease/force-release`, {
        method: "POST",
        body: JSON.stringify({ reason, epoch: leaseEpoch.current }),
      });
      armedControl.current = false;
      modeRef.current = "view";
      setMode("view");
      const closing = activeSocket ?? rfbRef.current;
      rfbRef.current = null;
      await enqueueSocket(() => releaseSocket(closing));
      if (wantViewRef.current) await startView();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not release the desktop lease."));
    } finally {
      setBusy(null);
    }
  }

  async function continueBot() {
    setBusy("continue");
    setError(null);
    try {
      await api(`/api/computers/${botId}/continue`, { method: "POST" });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not continue the bot."));
    } finally {
      setBusy(null);
    }
  }

  async function resolveAttention(taskId: string) {
    setBusy(`attention-${taskId}`);
    setError(null);
    try {
      await api(`/api/tasks/${taskId}/attention/resolve`, { method: "POST" });
      toast.success("Attention resolved.");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not resolve attention."));
    } finally {
      setBusy(null);
    }
  }

  async function humanClick() {
    if (mode !== "control") return;
    setBusy("click");
    setError(null);
    try {
      await api(`/api/bots/${botId}/computer/human-input`, {
        method: "POST",
        body: JSON.stringify({ selector: "#human-check", tabId: desktopTabId(), epoch: leaseEpoch.current }),
      });
      toast.success("Click sent.");
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not send the click."));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const points = new Map<number, { x: number; y: number }>();
    let pinchStart = 0;
    let pinchZoom = 1;
    let pinchPan = { x: 0, y: 0 };
    let dragFrom = { x: 0, y: 0 };
    let dragPan = { x: 0, y: 0 };
    let dragging = false;

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || event.pointerType === "") {
        // noVNC inserts a capture element on pointerdown, so the later click is retargeted
        // and never reaches this frame. Expand from the pointerdown itself.
        if ((event.target as HTMLElement | null)?.closest?.("[data-no-expand]")) return;
        if (compactRef.current && !fullscreenRef.current) expandRef.current?.();
        return;
      }
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size >= 2) {
        const [a, b] = [...points.values()];
        pinchStart = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        pinchZoom = zoomRef.current;
        pinchPan = { ...panRef.current };
        event.preventDefault();
        event.stopPropagation();
      } else if (modeRef.current !== "control" && zoomRef.current > 1) {
        dragging = true;
        dragFrom = { x: event.clientX, y: event.clientY };
        dragPan = { ...panRef.current };
        event.preventDefault();
      }
    };
    const onMove = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size >= 2 && pinchStart > 0) {
        const [a, b] = [...points.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const next = pinchZoom * (dist / pinchStart);
        const rect = frame.getBoundingClientRect();
        const ox = (a.x + b.x) / 2 - rect.left;
        const oy = (a.y + b.y) / 2 - rect.top;
        const ratio = pinchZoom === 0 ? 1 : next / pinchZoom;
        place(next, { x: ox - (ox - pinchPan.x) * ratio, y: oy - (oy - pinchPan.y) * ratio });
        event.preventDefault();
        event.stopPropagation();
      } else if (dragging && modeRef.current !== "control") {
        place(zoomRef.current, { x: dragPan.x + event.clientX - dragFrom.x, y: dragPan.y + event.clientY - dragFrom.y });
        event.preventDefault();
      }
    };
    const onUp = (event: PointerEvent) => {
      points.delete(event.pointerId);
      if (points.size < 2) pinchStart = 0;
      if (points.size === 0) dragging = false;
    };
    frame.addEventListener("pointerdown", onDown, { capture: true });
    frame.addEventListener("pointermove", onMove, { capture: true });
    frame.addEventListener("pointerup", onUp, { capture: true });
    frame.addEventListener("pointercancel", onUp, { capture: true });
    return () => {
      frame.removeEventListener("pointerdown", onDown, { capture: true });
      frame.removeEventListener("pointermove", onMove, { capture: true });
      frame.removeEventListener("pointerup", onUp, { capture: true });
      frame.removeEventListener("pointercancel", onUp, { capture: true });
    };
    // Reattach when video progress gives way to the desktop frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoOnly]);

  const asleep = power === "hibernated" || power === "stopped";
  const needsHelp = waiting.length > 0;
  const actionLabel = controlActionLabel(mode, needsHelp);
  const fill = fullscreen || nativeFs;
  const controlPill = (
    <div data-testid="computer-control-pill" className="inline-flex min-h-11 w-fit max-w-full flex-nowrap items-center gap-1.5 rounded-full bg-card px-1.5 py-1 text-meta text-card-foreground shadow-sm">
      {mode === "view" ? <Eye className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <MousePointer2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span data-testid={mode === "view" ? "watch-only" : undefined} className={cn("whitespace-nowrap", mode === "view" ? "text-muted-foreground" : undefined)}>{mode === "view" ? "Watching" : "You're in control"}</span>
      {mode === "view" ? (
        <button type="button" data-testid="take-control" className="min-h-9 whitespace-nowrap rounded-full bg-primary px-3 text-meta font-medium text-primary-foreground disabled:opacity-50" disabled={busy !== null} onClick={() => void takeControl()}>
          {actionLabel}
        </button>
      ) : (
        <button type="button" data-testid="hand-back" className="min-h-9 whitespace-nowrap rounded-full bg-secondary px-3 text-meta font-medium text-secondary-foreground disabled:opacity-50" disabled={busy !== null} onClick={() => void handBack()}>
          {actionLabel}
        </button>
      )}
    </div>
  );
  useEffect(() => {
    if (!fullscreen) return;
    setCollapsedView(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.fullscreenElement) return;
      event.preventDefault();
      event.stopPropagation();
      void closeView();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [fullscreen, onExitFullscreen]);

  async function closeView() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    if (mode === "control" || holder === "human") await handBack();
    onExitFullscreen?.();
  }

  if (videoProgress) return <div data-testid="computer-tab" className="flex min-h-32 items-center justify-center rounded-card bg-card p-4">
    <VideoProgress progress={videoProgress} />
  </div>;

  const view = (
    <div
      ref={rootRef}
      data-testid="computer-tab"
      data-vnc-state={vncState}
      data-desktop-mode={mode}
      data-power={power}
      className={cn("flex min-h-0 min-w-0 flex-col gap-3", !compact && "md:flex-1", fullscreen && !exiting && "motion-pop", exiting && "motion-pop-out pointer-events-none", fullscreen && "fixed inset-0 z-[80] gap-2 overflow-hidden bg-background p-3")}
    >
      <div ref={stageRef} data-testid="desktop-stage" className={cn("relative flex min-h-0 min-w-0 flex-col gap-2", fill && "h-full flex-1 bg-background")}>
        {fullscreen ? (
          <div className="flex shrink-0 items-center justify-end gap-2" data-testid="computer-topbar">
            <p data-testid="vnc-status" className="sr-only">{statusLabel(vncState)}</p>
            {mode === "control" ? <Button type="button" data-testid="desktop-keyboard-toggle" variant="ghost" size="sm" aria-pressed={keyboard} onClick={toggleKeyboard}>Keyboard</Button> : null}
            {zoom > 1.01 ? <Button type="button" data-testid="desktop-fit" variant="ghost" size="sm" onClick={fitWidth}>Fit width</Button> : null}
            <Button type="button" data-testid="computer-minimise" variant="ghost" size="icon" aria-label="Minimise to the panel" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); onExitFullscreen?.(); }}><Minimize2 className="size-4" aria-hidden /></Button>
            <Button type="button" data-testid="computer-collapse" variant="ghost" size="icon" aria-expanded={!collapsedView} aria-controls="computer-frame-wrap" aria-label={collapsedView ? "Restore desktop" : "Collapse desktop"} onClick={() => setCollapsedView(value => !value)}><Minus className="size-4" aria-hidden /></Button>
            <Button type="button" data-testid="desktop-fullscreen" variant="ghost" size="icon" aria-pressed={nativeFs} aria-label={nativeFs ? "Exit full screen" : "Full screen"} onClick={() => void toggleFullscreen()}><Maximize2 className="size-4" aria-hidden /></Button>
            <Button type="button" data-testid="computer-close" variant="outline" className="min-h-11 bg-card" onClick={() => void closeView()}>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-col gap-1">
            <p className="text-body-sm text-muted-foreground">{holder === "human" ? "You have the computer." : "The agent has the computer."}</p>
            <p data-testid="vnc-status" className="text-body-sm font-medium">{statusLabel(vncState)}</p>
            {mode === "view" ? (
              <p data-testid="watch-only" className="text-body-sm font-medium md:hidden">
                Watch only
              </p>
            ) : null}
            <p className="text-meta text-muted-foreground">{mode === "control" ? "The pointer is yours." : "View only, until you take control."}</p>
          </div>
        )}
        {asleep ? (
          <button type="button" data-testid="computer-asleep" className="flex w-full flex-col items-center gap-1 rounded-xl bg-card px-3 py-5 text-card-foreground" disabled={busy !== null} onClick={() => void wake()}>
            <span className="flex items-end gap-2">
              <span className="opacity-50 grayscale">
                <BotAvatar botId={botId} shape={avatarShape} color={avatarColor} size={40} />
              </span>
              <span className="pb-1 text-body-sm tracking-widest text-muted-foreground" aria-hidden>z z</span>
            </span>
            <span className="text-body-sm font-medium">Computer is asleep</span>
            <span data-testid="computer-wake" className="text-meta text-muted-foreground">Tap to wake</span>
          </button>
        ) : null}
        <div id="computer-frame-wrap" className={cn("grid w-full place-items-center", (asleep || (fullscreen && collapsedView)) && "hidden", fill && "min-h-0 w-full flex-1")}>
          <div data-testid="computer-thumbnail" className={cn("group relative w-full", fill && "h-full min-h-0")}>
            <div
              ref={frameRef}
              data-testid="desktop-frame"
              data-phase={phase}
              data-recording={recording ? "true" : undefined}
              role={compact && !fullscreen ? "button" : undefined}
              tabIndex={compact && !fullscreen ? 0 : undefined}
              aria-label={compact && !fullscreen ? `Open ${caption || "Teammate"}'s computer` : undefined}
              onKeyDown={compact && !fullscreen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onExpand?.(); } } : undefined}
              data-zoom={zoom.toFixed(2)}
              className={cn(
                "relative touch-none overflow-hidden bg-background",
                fullscreen ? "rounded-dialog" : "rounded-control",
                fill ? "h-full min-h-[12rem] w-full" : "aspect-video w-full",
                compact && !fullscreen && "cursor-pointer",
                fullscreen && recording && "outline outline-2 outline-offset-2 outline-destructive",
                fullscreen && mode === "control" && !recording && "ring-2 ring-bot/70",
              )}
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest?.("[data-no-expand]")) return;
                if (compact && !fullscreen) onExpand?.();
              }}
            >
              <div
                ref={screenRef}
                className="absolute inset-0"
                style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, left: pan.x, top: pan.y }}
                aria-label="Bot desktop"
              />
              {phase !== "live" && !asleep ? <ComputerState phase={phase} name={caption || "Teammate"} avatar={avatar ?? <BotAvatar botId={botId} shape={avatarShape} color={avatarColor} size={40} />} onRetry={retryConnect} /> : null}
              {compact && !fullscreen ? <DisplayDots count={displays} /> : null}
              {compact && !fullscreen && (mode === "control" || holder === "human") ? <span data-testid="control-chip" className="absolute right-2 top-2 rounded-md bg-bot px-2.5 py-1 text-meta font-medium text-bot-foreground shadow">You&apos;re in control · bot paused</span> : null}
            </div>
            {!fullscreen && phase === "live" ? (
              <button
                type="button"
                data-testid="computer-open"
                className={cn("absolute inset-0 z-10 grid place-items-center bg-overlay opacity-0 pointer-events-none transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100", fullscreen ? "rounded-dialog" : "rounded-control")}
                onClick={(event) => {
                  event.stopPropagation();
                  onExpand?.();
                }}
              >
                <span className="computer-open-label rounded-full px-3 py-1 text-body-sm font-medium">↗ Open</span>
              </button>
            ) : null}
          </div>
        </div>
        {fullscreen && collapsedView ? <p className="grid flex-1 place-items-center text-body-sm text-muted-foreground">The desktop is collapsed.</p> : null}
        {!fullscreen && caption ? (
          <p data-testid="computer-caption" className="text-center text-meta text-muted-foreground">{caption}&apos;s screen</p>
        ) : null}
        <div data-testid="control-pill" data-mode={mode} role="status" className={cn("flex justify-center", fullscreen && "pointer-events-none absolute inset-x-0 bottom-4")}>
          <div className={fullscreen ? "pointer-events-auto" : undefined}>{controlPill}</div>
        </div>
        <div className="flex flex-wrap gap-2">
            {holder === "human" ? <Button data-testid="force-release" variant="destructive" className="min-h-11" disabled={busy !== null} onClick={() => void forceRelease()}>Force release</Button> : null}
          {!fullscreen ? <>
            <Button data-testid="desktop-fullscreen" variant="secondary" className="min-h-11 flex-1" onClick={() => void toggleFullscreen()}>
              Full screen
            </Button>
            <Button data-testid="desktop-keyboard-toggle" variant="secondary" className="min-h-11 flex-1" aria-pressed={keyboard} onClick={toggleKeyboard}>
              Keyboard
            </Button>
            <Button data-testid="desktop-fit" variant="secondary" className="min-h-11 flex-1" onClick={fitWidth}>
              Fit width
            </Button>
          </> : null}
        </div>
        {!(fullscreen && collapsedView) ? <ComputerJobs botId={botId} controlled={mode === "control" || holder === "human"} /> : null}
        {keyboard ? (
          <input
            ref={keyRef}
            data-testid="desktop-keyboard"
            className="min-h-11 w-full rounded-md border border-border bg-card px-3 text-lead"
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Desktop keyboard"
            placeholder="Type to the computer"
            onChange={(event) => onKeyboard(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendSpecial(0xff0d);
              } else if (event.key === "Backspace" && keyValue.current.length === 0) {
                sendSpecial(0xff08);
              }
            }}
          />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {waiting.length > 0 ? (
        <div data-testid="attention-banner" role="status" className={cn("rounded-lg border border-border bg-card p-4", fullscreen && "mx-auto w-[min(32rem,92vw)] shrink-0 max-h-[40vh] overflow-y-auto border-computer-foreground/10 bg-computer-background text-computer-foreground shadow-xl")}>
          <p className="font-medium">A task is waiting on you.</p>
          <p className="mt-1 text-body-sm">The bot waits for you to finish the human step and explicitly continue.</p>
          <ul className="mt-3 flex flex-col gap-3">
            {waiting.filter((task) => task.waitingReason !== "await_continue").map((task) => (
              <li key={task.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-body-sm font-medium">{task.title || task.instruction || "Waiting task"}</p>
                  {task.waitingReason ? <p className="text-body-sm text-muted-foreground">{task.waitingReason}</p> : null}
                </div>
                <Button data-testid="resolve-attention" size="sm" disabled={busy !== null} onClick={() => void resolveAttention(task.id)}>
                  Resolve attention
                </Button>
              </li>
            ))}
          </ul>
          {waiting.some((task) => task.waitingReason === "await_continue") && mode !== "control" ? (
            <Button data-testid="continue-bot" size="sm" className="mt-3" disabled={busy !== null} onClick={() => void continueBot()}>
              Continue bot
            </Button>
          ) : null}
          {mode === "control" ? (
            <div className="mt-3">
              <Button data-testid="human-click" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void humanClick()}>
                Click human check
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-meta text-muted-foreground">Take control before sending the human click.</p>
          )}
        </div>
      ) : null}
      {!fullscreen ? (
        <section>
        <h3 className="text-body-sm font-medium">Open pages</h3>
        {pages.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">No browser pages open.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {pages.map((page) => (
              <li key={page.targetId} data-testid="browser-page" className="rounded-lg border border-border bg-card px-3 py-2">
                <p className="text-body-sm font-medium">{page.title || "Untitled page"}</p>
                <p className="truncate text-meta text-muted-foreground">{page.url}</p>
              </li>
            ))}
          </ul>
        )}
        </section>
      ) : null}
    </div>
  );
  return view;
}
