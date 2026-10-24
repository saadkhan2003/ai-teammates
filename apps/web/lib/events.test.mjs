import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const source = readFileSync(new URL("./events.ts", import.meta.url), "utf8").replace(/import .* from "@\/lib\/connection";/, 'const REFRESH_EVENT = "refresh"; const reportFailure = () => {}; const reportSuccess = () => {};');
const output = ts.transpileModule(source, { compilerOptions: { module: "esnext", target: "es2022" } }).outputText;
const events = await import("data:text/javascript;base64," + Buffer.from(output).toString("base64"));
test("SSE ready payload has no application event type and is ignored", () => {
  assert.equal(events.parseAgentEvent("{}"), null);
  assert.equal(events.parseAgentEvent(""), null);
  assert.equal(events.parseAgentEvent('{"type":"task","taskId":"example"}').type, "task");
});
test("named ready frames do not invoke application subscribers or disturb resume ids", async () => {
  const listeners = new Map();
  globalThis.window = { clearTimeout, setTimeout, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(': connected\n\nevent: ready\ndata: {}\n\nid: 4\ndata: {"type":"task"}\n\n'));
    controller.close();
  } }), { status: 200 });
  const received = [];
  const statuses = [];
  let stop;
  try {
    await new Promise(resolve => {
      stop = events.subscribeEvents(data => { received.push(data); stop(); resolve(); }, status => statuses.push(status));
    });
    assert.deepEqual(received, ['{"type":"task"}']);
    assert.equal(statuses.at(-1).lastId, "4");
  } finally { stop?.(); globalThis.fetch = originalFetch; delete globalThis.window; delete globalThis.document; }
});
