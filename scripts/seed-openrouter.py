#!/usr/bin/env python3
"""Idempotent installer seed. Never put credentials in arguments or diagnostics."""
import http.cookiejar
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


def owner_credentials(environ):
    values = dict(environ)
    # Runtime-only fallback. Never source a shell file or evaluate substitutions.
    if not values.get('OWNER_PASSWORD'):
        path = Path(__file__).resolve().parents[1] / '.env'
        if path.exists():
            for line in path.read_text().splitlines():
                name, sep, value = line.partition('=')
                if sep and name.strip() in {'OWNER_USERNAME', 'OWNER_PASSWORD'}:
                    values.setdefault(name.strip(), value.strip().strip('\"\''))
    return values.get('OWNER_USERNAME', 'saad'), values.get('OWNER_PASSWORD', '')


def seed(environ=os.environ, *, opener=None, credentials=owner_credentials, sleep=time.sleep):
    key = environ.get('OPENROUTER_API_KEY', '')
    if not key:
        return 0
    base = environ.get('SEED_API_URL', 'http://127.0.0.1:18080').rstrip('/')
    opener = opener or urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, data=data, method=method, headers={'Content-Type': 'application/json'})
        with opener.open(request, timeout=10) as response:
            return json.loads(response.read() or b'{}')
    for attempt in range(30):
        try:
            call('GET', '/health')
            break
        except (OSError, ValueError):
            if attempt == 29:
                print('API not ready. Re-run scripts/install.sh after starting the stack to seed the model key.')
                return 1
            sleep(2)
    try:
        username, password = credentials(environ)
        call('POST', '/api/auth/login', {'username': username, 'password': password})
        status = call('GET', '/api/system/llm-status')
        existing = call('GET', '/api/secrets') if not status.get('hasKey') else []
        has_record = any(row.get('provider') == 'openrouter' and row.get('name') == 'default' for row in existing)
        if not status.get('hasKey') and not has_record:
            call('POST', '/api/secrets', {'namespace': 'openrouter', 'name': 'default', 'type': 'API_KEY', 'value': key})
        print('Model key setup complete.')
        return 0
    except (OSError, ValueError):
        # Exception messages and response bodies may contain credentials.
        print('Model key setup could not finish. Check owner credentials and API availability.')
        return 1


if __name__ == '__main__':
    raise SystemExit(seed())
