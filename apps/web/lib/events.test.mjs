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

test('subscribers share one transport and fan out until the final listener disconnects', async () => {
  globalThis.window = { clearTimeout, setTimeout, addEventListener() {}, removeEventListener() {} };
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const originalFetch = globalThis.fetch;
  let connections = 0; let writer;
  globalThis.fetch = async (_url, init) => {
    connections++;
    return new Response(new ReadableStream({start(controller) { writer = controller; init.signal.addEventListener('abort', () => controller.close()); }}));
  };
  const a = [], b = [];
  const stopA = events.subscribeEvents(data => a.push(data));
  const stopB = events.subscribeEvents(data => b.push(data));
  try {
    await new Promise(r => setImmediate(r));
    writer.enqueue(new TextEncoder().encode('id: 5\ndata: {"type":"task"}\n\n'));
    await new Promise(r => setImmediate(r));
    assert.equal(connections,1); assert.deepEqual(a,b); assert.equal(a.length,1);
    stopA(); writer.enqueue(new TextEncoder().encode('id: 6\ndata: {"type":"task"}\n\n'));
    await new Promise(r => setImmediate(r));
    assert.equal(a.length,1); assert.equal(b.length,2);
  } finally { stopA(); stopB(); globalThis.fetch=originalFetch; delete globalThis.window; delete globalThis.document; }
});
