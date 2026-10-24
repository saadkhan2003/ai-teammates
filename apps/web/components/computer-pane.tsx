"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, readDesktopToken } from "@/lib/api";
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

function socketUrl(token: string) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/vnc/websockify?token=${encodeURIComponent(token)}`;
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

export function ComputerPane({
  botId,
  tasks,
  pages,
  holder,
  onChanged,
  compact = false,
  caption,
  fullscreen = false,
  onExpand,
  onExitFullscreen,
}: {
  botId: string;
  tasks: Task[];
  pages: BrowserPage[];
  holder: "agent" | "human";
  onChanged: () => void;
  compact?: boolean;
  caption?: string;
  fullscreen?: boolean;
  onExpand?: () => void;
  onExitFullscreen?: () => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const sessionRef = useRef(0);
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
  const frameRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const keyValue = useRef("");
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  botIdRef.current = botId;

  const [vncState, setVncState] = useState<VncState>("disconnected");
  const [mode, setMode] = useState<DesktopMode>("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [keyboard, setKeyboard] = useState(false);
  const [nativeFs, setNativeFs] = useState(false);
  const [power, setPower] = useState<string>("unknown");
  zoomRef.current = zoom;
  panRef.current = pan;
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
    if (gen !== connectGen.current || !wantViewRef.current) return;
    const imported = await import("@novnc/novnc/lib/rfb.js");
    if (gen !== connectGen.current || !wantViewRef.current) return;
    const screen = screenRef.current;
    if (!screen || !token) throw new Error("The desktop session did not include a token.");
    screen.replaceChildren();
    const session = ++sessionRef.current;
    const RFB = imported.default;
    const rfb = new RFB(screen, socketUrl(token)) as unknown as RfbClient;
    const resolved: DesktopMode = mobileRef.current && nextMode === "control" && !armedControl.current ? "view" : nextMode;
    rfb.scaleViewport = true;
    rfb.showDotCursor = true;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
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
      if (gen !== connectGen.current || !wantViewRef.current) return;
      if (activeSocket || rfbRef.current) {
        ignoreRef.current.add(sessionRef.current);
        const previous = activeSocket ?? rfbRef.current;
        rfbRef.current = null;
        liveRef.current = false;
        openingRef.current = false;
        await releaseSocket(previous);
      }
      if (gen !== connectGen.current || !wantViewRef.current) return;
      const raw = await api<unknown>(path, { method: "POST" });
      if (gen !== connectGen.current || !wantViewRef.current) return;
      const token = readDesktopToken(raw);
      const mode = token.mode === "control" ? "control" : nextMode;
      await openSocket(token.token, mode, gen);
    });
  }

  async function startView() {
    if (!wantViewRef.current) return;
    if (liveRef.current || openingRef.current || pendingRef.current) return;
    pendingRef.current = true;
    clearReconnect();
    const gen = ++connectGen.current;
    setError(null);
    try {
      await openView("view", `/api/bots/${botIdRef.current}/computer/view-token`, gen);
    } catch (caught) {
      if (gen !== connectGen.current || !wantViewRef.current) return;
      liveRef.current = false;
      openingRef.current = false;
      setVncState("disconnected");
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
    const onChange = () => setNativeFs(document.fullscreenElement === stageRef.current);
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
  }, []);

  useEffect(() => {
    mobileRef.current = window.matchMedia("(max-width: 767px)").matches;
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = () => {
      mobileRef.current = query.matches;
    };
    query.addEventListener("change", onChange);
    wantViewRef.current = true;
    void startView();
    return () => {
      query.removeEventListener("change", onChange);
      closePaneSocket();
    };
    // Reconnect when the bot changes. Cleanup closes the previous socket first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

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
      wantViewRef.current = true;
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
      await openView("control", `/api/bots/${botId}/computer/take-control`, gen);
      if (gen === connectGen.current) onChanged();
    } catch (caught) {
      if (gen === connectGen.current) setError(errorMessage(caught, "Could not take control."));
    } finally {
      if (gen === connectGen.current) pendingRef.current = false;
      setBusy(null);
    }
  }

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
    const node = stageRef.current;
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
      await api(`/api/bots/${botId}/computer/hand-back`, { method: "POST" });
      ignoreRef.current.add(sessionRef.current);
      const closing = activeSocket ?? rfbRef.current;
      rfbRef.current = null;
      liveRef.current = false;
      openingRef.current = false;
      modeRef.current = "view";
      await enqueueSocket(() => releaseSocket(closing));
      if (gen !== connectGen.current || !wantViewRef.current) return;
      pendingRef.current = false;
      reconnectAttempt.current = 0;
      setVncState("disconnected");
      await startView();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, "Could not hand the computer back."));
    } finally {
      if (gen === connectGen.current) pendingRef.current = false;
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
        body: JSON.stringify({ selector: "#human-check" }),
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
    // place reads refs and setState, which stay stable for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fillWindow = fullscreen || nativeFs || !compact;
  const view = (
    <div
      data-testid="computer-tab"
      data-vnc-state={vncState}
      data-desktop-mode={mode}
      className={cn("flex min-h-0 min-w-0 flex-col gap-3", !compact && "md:flex-1", fullscreen && "fixed inset-0 z-[80] gap-2 overflow-hidden bg-background")}
    >
      <div ref={stageRef} data-testid="desktop-stage" className={cn("flex min-h-0 min-w-0 flex-col gap-2 bg-background", !compact && "md:min-h-[14rem] md:flex-1")}>
        {fullscreen ? (
          <div className="flex shrink-0 items-center gap-2">
            <p className="text-sm font-medium">Computer</p>
            <p data-testid="vnc-status" className="text-sm font-medium">
              {statusLabel(vncState)}
            </p>
            <div className="ml-auto flex gap-2">
              <Button data-testid="take-control" className="min-h-11" disabled={busy !== null} onClick={() => void takeControl()}>
                Take control
              </Button>
              <Button data-testid="hand-back" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => void handBack()}>
                Hand back
              </Button>
              <Button type="button" variant="outline" className="min-h-11" onClick={onExitFullscreen}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
        {compact ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{statusLabel(vncState)}</p>
            {power === "hibernated" || power === "stopped" ? (
              <div data-testid="computer-asleep" className="rounded-xl border border-border bg-card px-3 py-3 text-sm">
                <p className="font-medium">The computer is asleep.</p>
                <Button type="button" data-testid="computer-wake" className="mt-2 min-h-11" disabled={busy !== null} onClick={() => void wake()}>
                  Wake
                </Button>
              </div>
            ) : null}
            <div data-testid="computer-control-pill" className="inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-border bg-card px-3 text-sm">
              {mode === "view" ? (
                <>
                  <span>Watching</span>
                  <span aria-hidden>·</span>
                  <button type="button" data-testid="take-control" className="font-medium" disabled={busy !== null} onClick={() => void takeControl()}>
                    Take control
                  </button>
                </>
              ) : (
                <>
                  <span>You&apos;re in control</span>
                  <span aria-hidden>·</span>
                  <button type="button" data-testid="computer-stop" disabled={busy !== null} onClick={() => void handBack()}>
                    Stop
                  </button>
                  <span aria-hidden>/</span>
                  <button type="button" data-testid="hand-back" className="font-semibold" disabled={busy !== null} onClick={() => void handBack()}>
                    I&apos;m done
                  </button>
                </>
              )}
            </div>
          </div>
        ) : fullscreen ? null : (
        <div className="flex shrink-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {holder === "human" ? "You have the computer." : "The agent has the computer."}
          </p>
          <p data-testid="vnc-status" className="text-sm font-medium">
            {statusLabel(vncState)}
          </p>
          {mode === "view" ? (
            <p data-testid="watch-only" className="text-sm font-medium md:hidden">
              Watch only
            </p>
          ) : null}
          {power === "hibernated" || power === "stopped" ? (
            <div data-testid="computer-asleep" className="rounded-xl border border-border bg-card px-3 py-3 text-sm">
              <p className="font-medium">The computer is asleep.</p>
              <Button type="button" data-testid="computer-wake" className="mt-2 min-h-11" disabled={busy !== null} onClick={() => void wake()}>
                Wake
              </Button>
            </div>
          ) : null}
          <div data-testid="computer-control-pill" className="inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-border bg-card px-3 text-sm">
            {mode === "view" ? (
              <>
                <span>Watching</span>
                <span aria-hidden>·</span>
                <button type="button" data-testid="take-control" className="font-medium" disabled={busy !== null} onClick={() => void takeControl()}>
                  Take control
                </button>
              </>
            ) : (
              <>
                <span>You&apos;re in control</span>
                <span aria-hidden>·</span>
                <button type="button" data-testid="computer-stop" disabled={busy !== null} onClick={() => void handBack()}>
                  Stop
                </button>
                <span aria-hidden>/</span>
                <button type="button" data-testid="hand-back" className="font-semibold" disabled={busy !== null} onClick={() => void handBack()}>
                  I&apos;m done
                </button>
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="desktop-fullscreen"
              variant="secondary"
              className="min-h-11 flex-1"
              onClick={() => void toggleFullscreen()}
            >
              Full screen
            </Button>
            <Button data-testid="desktop-keyboard-toggle" variant="secondary" className="min-h-11 flex-1" aria-pressed={keyboard} onClick={toggleKeyboard}>
              Keyboard
            </Button>
            <Button data-testid="desktop-fit" variant="secondary" className="min-h-11 flex-1" onClick={fitWidth}>
              Fit width
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === "control" ? "The pointer is yours." : "View only, until you take control."}
          </p>
        </div>
        )}
        <div className={cn("grid w-full place-items-center", fillWindow && (fullscreen || nativeFs ? "min-h-0 w-full flex-1 [container-type:size]" : "md:min-h-[14rem] md:w-full md:flex-1 md:[container-type:size]"))}>
        <div
          ref={frameRef}
          data-testid="desktop-frame"
          data-zoom={zoom.toFixed(2)}
          className={cn(
            "relative touch-none overflow-hidden bg-background",
            fillWindow
              ? (fullscreen || nativeFs ? "h-full w-full" : "aspect-[4/3] w-full md:aspect-auto md:h-full")
              : "aspect-[4/3] w-full",
            compact && "cursor-pointer rounded-lg",
          )}
          onClickCapture={() => {
            if (compact && !fullscreen) onExpand?.();
          }}
        >
          <div
            ref={screenRef}
            className="absolute inset-0"
            style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, left: pan.x, top: pan.y }}
            aria-label="Bot desktop"
          />
        </div>
        </div>
        {compact && caption ? <p className="text-center text-xs text-muted-foreground">{caption}&apos;s screen</p> : null}
        {keyboard ? (
          <input
            ref={keyRef}
            data-testid="desktop-keyboard"
            className="min-h-11 w-full rounded-md border border-border bg-card px-3 text-base"
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
      {!compact && !fullscreen && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!compact && !fullscreen && waiting.length > 0 ? (
        <div data-testid="attention-banner" role="status" className="rounded-lg border border-border bg-card p-4">
          <p className="font-medium">A task is waiting on you.</p>
          <p className="mt-1 text-sm">The bot stopped for a human check. Take control, finish it, then hand the computer back.</p>
          <ul className="mt-3 flex flex-col gap-3">
            {waiting.map((task) => (
              <li key={task.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{task.title || task.instruction || "Waiting task"}</p>
                  {task.waitingReason ? <p className="text-sm text-muted-foreground">{task.waitingReason}</p> : null}
                </div>
                <Button data-testid="resolve-attention" size="sm" disabled={busy !== null} onClick={() => void resolveAttention(task.id)}>
                  Resolve attention
                </Button>
              </li>
            ))}
          </ul>
          {mode === "control" ? (
            <div className="mt-3">
              <Button data-testid="human-click" size="sm" variant="secondary" disabled={busy !== null} onClick={() => void humanClick()}>
                Click human check
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Take control before sending the human click.</p>
          )}
        </div>
      ) : null}
      {!compact && !fullscreen ? <section>
        <h3 className="text-sm font-medium">Open pages</h3>
        {pages.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No browser pages open.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {pages.map((page) => (
              <li key={page.targetId} data-testid="browser-page" className="rounded-lg border border-line bg-paper px-3 py-2">
                <p className="text-sm font-medium">{page.title || "Untitled page"}</p>
                <p className="truncate text-xs text-muted-foreground">{page.url}</p>
              </li>
            ))}
          </ul>
        )}
      </section> : null}
    </div>
  );
  return view;
}
