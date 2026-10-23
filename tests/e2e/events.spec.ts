import { expect, test } from "@playwright/test";
import { mergeAgentEvent, parseAgentEvent, type AgentEvent } from "../../apps/web/lib/events";

for (const data of ["", "{", "null", "[]", '"text"', '{"type":3}']) {
  test(`malformed event is ignored: ${JSON.stringify(data)}`, () => {
    expect(parseAgentEvent(data)).toBeNull();
  });
}
test("unknown event types remain forward compatible", () => {
  expect(parseAgentEvent('{"type":"future","detail":{"ok":true}}')).toEqual({ type: "future", detail: { ok: true } });
});
test("tool updates collapse into the same card without mixing tasks", () => {
  const first: AgentEvent = { type: "tool_call", taskId: "one", callId: "call", tool: "browser_open", args: { url: "https://example.com" } };
  const current = mergeAgentEvent([first], { type: "tool_result", taskId: "one", callId: "call", status: "done", result: "ok" });
  expect(current).toHaveLength(1);
  expect(current[0].tool).toBe("browser_open");
  expect(current[0].status).toBe("done");
  expect(mergeAgentEvent(current, { type: "tool_result", taskId: "two", callId: "call" })).toHaveLength(2);
});
test("grounding updates replace counts per task and delta buffers are bounded", () => {
  let current: AgentEvent[] = [{ type: "grounding", taskId: "one", verified: 2, removed: 1 }];
  current = mergeAgentEvent(current, { type: "grounding", taskId: "one", verified: 3, removed: 2 });
  expect(current).toHaveLength(1);
  expect(current[0].verified).toBe(3);
  for (let i = 0; i < 150; i++) current = mergeAgentEvent(current, { type: "delta", text: String(i) });
  expect(current).toHaveLength(2);
  expect(current.at(-1)?.delta).toBe(Array.from({ length: 150 }, (_, i) => String(i)).join(""));
  for (let i = 0; i < 150; i++) current = mergeAgentEvent(current, { type: "tool_call", taskId: String(i), tool: "search" });
  expect(current).toHaveLength(100);
});
