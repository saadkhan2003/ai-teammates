# Speed load measurement

Build k6 with the SSE extension (Go and xk6 required):

```sh
go install go.k6.io/xk6/cmd/xk6@latest
xk6 build --with github.com/phymbert/xk6-sse
BASE_URL=http://your-isolated-stack K6_USER=owner K6_PASSWORD="$TEST_OWNER_PASSWORD" ./k6 run tests/load/k6-speed.js
```

Use a mock-provider test stack. Credentials come from the environment; never put them in the script or logs. Setup signs in once, respecting the login limiter, and shares that session with all VUs. The scenario ramps to 50 then 200 VUs. Each iteration requests 3–4 cheap JSON routes, then opens an SSE connection, records the time to the `ready` event, closes it and idles five seconds (xk6-sse callbacks cannot sleep or use timers, so connections are not held open; server fan-out is recorded as `sse_fanout_ms`). `event: ready` provides the first-event clock even on an idle stack. No task or provider calls are generated.

Thresholds: first SSE event p95 <250 ms, JSON request p95 <150 ms, HTTP failures <1%. k6 reports the connection duration separately; it is not a JSON latency. Event latency is measured with the VU clock from SSE open, so it includes network time. Do not enable HTTP debug logging: it exposes the session cookie.
