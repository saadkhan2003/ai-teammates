"""Bounded transport retries; unsafe writes require server-confirmed replay safety."""
import asyncio
import httpx

TRANSIENT = {408, 429, 500, 502, 503, 504}
MAX_RETRIES = 3


def retry_safe(method: str, path: str, body: dict | None) -> bool:
    # Tool execution is never assumed idempotent merely because the client made a key.
    if path == '/internal/tools/execute':
        return False
    # Model completion is billable and should not be replayed after an ambiguous timeout.
    if path == '/internal/model/complete':
        return False
    return method in {'GET', 'PUT'} or path.endswith(('/heartbeat', '/status', '/transcript')) or path in {'/internal/tasks/lease', '/internal/coding-jobs'}


def side_effect_safe(body: dict | None, response: httpx.Response | None) -> bool:
    if not body or response is None:
        return False
    # Only a trusted API response may confirm downstream idempotency/status checking.
    return bool(body.get('idempotencyKey')) and response.headers.get('X-Idempotency-Safe') == 'true'


async def send_with_retry(client, method, path, body=None, *, sleep=asyncio.sleep):
    safe = retry_safe(method, path, body)
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = await client.request(method, path, json=body)
        except (httpx.TransportError, httpx.TimeoutException):
            if not safe or attempt == MAX_RETRIES:
                raise
        else:
            try:
                payload = response.json()
            except (ValueError, UnicodeError):
                payload = {}
            output = payload.get('output', {}) if isinstance(payload, dict) else {}
            structured_retry = (path == '/internal/tools/execute' and bool(body and body.get('idempotencyKey'))
                                and isinstance(output, dict) and output.get('retrySafe') is True
                                and isinstance(output.get('status'), int) and output.get('status') in TRANSIENT)
            if (response.status_code not in TRANSIENT and not structured_retry) or attempt == MAX_RETRIES:
                return response
            if not safe and not structured_retry and not side_effect_safe(body, response):
                return response
        await sleep(0.5 * 2 ** attempt)
    raise AssertionError('unreachable')
