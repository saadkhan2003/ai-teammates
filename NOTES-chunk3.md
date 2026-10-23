Chunk 3 integration notes:
- Device schema is db/011_devices.sql; rebuild API/web and apply the forward-only migrations.
- docs/COMPANION.md defines pairing/heartbeat contract for chunk 4. Public copy is apps/web/public/docs/COMPANION.md; keep them synchronized if changed.
- DeviceGate is registered in DI, deliberately not connected to worker dispatch.
- Chat accepts botId or known taskId-scoped events. Grounding handles the chunk 1 `{type,taskId,detail:{verified,removed}}` shape. Memory is already persisted as structured messages and renders Saved to notes.
- Current worker/API has no text-delta or tool-step SSE publisher. UI supports `delta`, `message.delta`, `text_delta` (text/delta), `tool`, `tool_call`, `tool_result` (tool,args,result,status), scoped by botId or taskId. Backend event publication belongs to chunk 1; do not invent streaming by animating completed messages. Refresh events continue to work.
- Site-wide allowance remains limited to the credential-use approvals supported by the API. UI does not widen backend policy.

Local verification:
- `dotnet test tests/unit/Teammates.UnitTests.csproj --verbosity quiet`: 151 passed, 0 failed, including 16 DevicesTests. No Docker invoked.
- `npm run build` (apps/web): passed; 15 generated static pages. `npx tsc --noEmit`: passed.
- `npx playwright test events.spec.ts --project desktop --reporter line`: 9 passed, 0 failed; these tests are browser-free and do not contact a stack.
- New browser spec strict type-check passed using apps/web's TypeScript and @types/node.
- Playwright test discovery passed. Full browser/integration tests deliberately deferred to orchestrator; rebuild web/API and apply db/011_devices.sql first.
- ASP.NET Pair route handler is explicitly cast to Delegate so its IResult response is written; no ASP0016 warnings in final unit run.
