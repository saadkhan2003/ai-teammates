import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import sse from 'k6/x/sse';

const base = (__ENV.BASE_URL || '').replace(/\/$/, '');
const firstEvent = new Trend('sse_first_event_ms', true);
export const options = {
  scenarios: { fanout: { executor: 'ramping-vus', startVUs: 0, stages: [
    { duration: '30s', target: 50 }, { duration: '30s', target: 50 },
    { duration: '60s', target: 200 }, { duration: '60s', target: 200 }, { duration: '15s', target: 0 },
  ], gracefulRampDown: '10s' } },
  thresholds: { sse_first_event_ms: ['p(95)<250'], 'http_req_duration{type:json}': ['p(95)<150'], http_req_failed: ['rate<0.01'] },
};
export function setup() {
  if (!base || !__ENV.K6_USER || !__ENV.K6_PASSWORD) throw new Error('BASE_URL, K6_USER and K6_PASSWORD are required');
  // One login for the entire run. No test-only rate-limit bypass or per-VU logins.
  const response = http.post(`${base}/api/auth/login`, JSON.stringify({ username: __ENV.K6_USER, password: __ENV.K6_PASSWORD }), { headers: { 'Content-Type': 'application/json' }, responseType: 'none' });
  if (response.status !== 200) throw new Error(`Login failed: HTTP ${response.status}`);
  const cookie = response.cookies.teammates_session?.[0]?.value;
  if (!cookie) throw new Error('No session cookie');
  const bots = http.get(`${base}/api/bots`, { headers: { Cookie: `teammates_session=${cookie}` }, tags: { type: 'json' } }).json();
  const list = Array.isArray(bots) ? bots : bots.bots || [];
  return { cookie, bot: list[0]?.id };
}
export default function(data) {
  const headers = { Cookie: `teammates_session=${data.cookie}` };
  // JSON requests happen before opening the blocking SSE connection.
  const routes = ['/api/auth/me', '/api/bots', '/api/system/llm-status'];
  if (data.bot) routes.push(`/api/bots/${data.bot}/messages?limit=20`);
  for (const route of routes) check(http.get(base + route, { headers, tags: { type: 'json' } }), { 'JSON ok': r => r.status === 200 });
  const start = Date.now();
  let seen = false;
  const response = sse.open(`${base}/api/events`, { headers, timeout: '8s', tags: { type: 'sse' } }, client => {
    client.on('event', event => {
      // The API writes `: connected` and `event: ready` in one flushed write; xk6-sse v0.2 surfaces the
      // leading comment frame and may not emit `ready` separately, so the first frame is the clock.
      if (!seen) {
        seen = true; firstEvent.add(Date.now() - start);
        // xk6-sse runs callbacks on its read loop: sleep() or k6/timers inside it never let close() complete,
        // so the connection is closed on the first event and the VU idles below. Server fan-out latency is
        // recorded separately as sse_fanout_ms by the API (admin Speed card).
        client.close();
      }
    });
  });
  if (!seen) firstEvent.add(8000); // Missing ready event must fail the latency threshold.
  check(response, { 'SSE opened': r => r && r.status === 200 });
  sleep(5);
}
