"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/lib/api";

type TicketResponse = { ticket: string; websocketPath: string; expiresInSeconds: number };

type TerminalProps = {
  computerId: string;
  botId: string;
  windowNumber?: number;
  className?: string;
};

export function Terminal({ computerId, botId, windowNumber = 1, className }: TerminalProps) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnects = 0;
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: "#111318", foreground: "#e5e7eb" },
    });
    terminal.open(mount.current);

    const connect = async () => {
      setStatus("Connecting…");
      try {
        const grant = await api<TicketResponse>(`/api/computers/${encodeURIComponent(computerId)}/terminal-ticket`, {
          method: "POST",
          body: JSON.stringify({ botId, window: windowNumber, role: "user" }),
        });
        if (disposed) return;
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${scheme}//${window.location.host}${grant.websocketPath}`, [`terminal-ticket.${grant.ticket}`]);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          reconnects = 0;
          setStatus("Connected");
          socket?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
          terminal.focus();
        };
        socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
          if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
        };
        socket.onerror = () => setStatus("Connection error");
        socket.onclose = () => {
          if (disposed) return;
          setStatus("Disconnected");
          if (reconnects < 6) {
            const delay = Math.min(1000 * 2 ** reconnects++, 15000);
            reconnectTimer = setTimeout(() => void connect(), delay);
          }
        };
      } catch {
        if (disposed) return;
        setStatus("Could not connect");
        if (reconnects < 6) {
          const delay = Math.min(1000 * 2 ** reconnects++, 15000);
          reconnectTimer = setTimeout(() => void connect(), delay);
        }
      }
    };

    const input = terminal.onData((data: string) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    });
    const resize = terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      input.dispose();
      resize.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [computerId, botId, windowNumber]);

  return (
    <section className={className} aria-label="Terminal">
      <div className="mb-1 text-xs text-muted-foreground" role="status">{status}</div>
      <div ref={mount} className="h-full min-h-64 w-full overflow-hidden rounded-md bg-[#111318] p-2" />
    </section>
  );
}
