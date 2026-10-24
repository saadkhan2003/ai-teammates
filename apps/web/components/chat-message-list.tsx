"use client";

import { forwardRef, type ReactNode, type RefObject, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage } from "@/lib/types";
import { VIRTUAL_CHAT_THRESHOLD } from "@/lib/chat-scroll";

export type ChatMessageListHandle = { reveal: (id: string) => void };
export const ChatMessageList = forwardRef<ChatMessageListHandle, {
  messages: ChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  renderMessage: (message: ChatMessage) => ReactNode;
}>(function ChatMessageList({ messages, scrollRef, renderMessage }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [focused, setFocused] = useState<string | null>(null);
  const virtual = messages.length > VIRTUAL_CHAT_THRESHOLD;
  const focusedIndex = messages.findIndex(message => message.id === focused);
  const rows = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    getItemKey: index => messages[index].id,
    estimateSize: () => 120,
    overscan: 6,
    gap: 8,
    scrollMargin: margin,
    // Stable ids let TanStack retain the visible row and its offset on prepend.
    anchorTo: "end",
    followOnAppend: false, // The pane also follows the draft/evidence below this list.
    rangeExtractor: range => {
      const indices = defaultRangeExtractor(range);
      if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
      return indices.sort((a, b) => a - b);
    },
  });
  // Compensate an estimate->actual delta only for rows wholly above the live
  // scrollTop; the cached offset lags fast jumps and pushed the top row out of reach.
  rows.shouldAdjustScrollPositionOnItemSizeChange = item => {
    const top = scrollRef.current?.scrollTop ?? 0;
    return top > 0 && item.start < top;
  };
  useLayoutEffect(() => {
    const update = () => {
      const element = host.current;
      const scroll = scrollRef.current;
      if (element && scroll) setMargin(element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
    };
    update();
    const observer = new ResizeObserver(update);
    if (host.current?.parentElement) observer.observe(host.current.parentElement);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [scrollRef, virtual]);
  useImperativeHandle(ref, () => ({ reveal(id) {
    const index = messages.findIndex(message => message.id === id);
    if (virtual && index >= 0) rows.scrollToIndex(index, { align: "center" });
  } }), [messages, virtual, rows]);
  const items = virtual ? rows.getVirtualItems() : messages.map((message, index) => ({ key: message.id, index, start: 0 }));
  return <div ref={host} data-testid="chat-message-list" data-virtualized={virtual} data-message-count={messages.length}
    className={virtual ? "relative w-full" : "flex w-full flex-col gap-2"}
    style={virtual ? { height: rows.getTotalSize() } : undefined}
    onFocusCapture={event => setFocused((event.target as HTMLElement).closest<HTMLElement>("[data-chat-row]")?.dataset.chatRow ?? null)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
    {items.map(item => <div key={item.key} data-index={item.index} data-chat-row={messages[item.index].id} tabIndex={-1}
      ref={virtual ? rows.measureElement : undefined}
      className={virtual ? "absolute left-0 top-0 flex w-full flex-col" : "flex w-full flex-col"}
      style={virtual ? { transform: `translateY(${item.start - margin}px)` } : undefined}>
      {renderMessage(messages[item.index])}
    </div>)}
  </div>;
});
