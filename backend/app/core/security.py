from __future__ import annotations

import re
from urllib.parse import urlparse

from fastapi import WebSocket

from app.core.config import settings


LOOPBACK_CORS_REGEX = r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$'


def expand_loopback_origins(origins: list[str]) -> list[str]:
    expanded: list[str] = []

    for origin in origins:
        candidates = [origin]

        parsed = urlparse(origin)
        if parsed.scheme in {'http', 'https'} and parsed.hostname in {'localhost', '127.0.0.1'}:
            port = f':{parsed.port}' if parsed.port else ''
            candidates = [f'{parsed.scheme}://localhost{port}', f'{parsed.scheme}://127.0.0.1{port}']

        for candidate in candidates:
            if candidate not in expanded:
                expanded.append(candidate)

    return expanded


def is_loopback_http_origin(origin: str) -> bool:
    parsed = urlparse(origin)
    return parsed.scheme in {'http', 'https'} and parsed.hostname in {'localhost', '127.0.0.1'}


def parse_allowed_origins(raw_value: str) -> tuple[list[str], str | None, bool]:
    allow_all_origins = raw_value.strip() == '*'
    configured_origins = [origin.strip() for origin in raw_value.split(',') if origin.strip()]
    allowed_origins = ['*'] if allow_all_origins else expand_loopback_origins(configured_origins)

    allow_origin_regex = None
    if not allow_all_origins and configured_origins and any(is_loopback_http_origin(origin) for origin in configured_origins):
        allow_origin_regex = LOOPBACK_CORS_REGEX

    return allowed_origins, allow_origin_regex, allow_all_origins


def parse_trusted_hosts(raw_value: str) -> list[str]:
    configured_hosts = [host.strip() for host in raw_value.split(',') if host.strip()]
    if not configured_hosts:
        return ['127.0.0.1', 'localhost']

    if '*' in configured_hosts:
        return ['*']

    normalized: list[str] = []
    for host in configured_hosts:
        parsed = urlparse(host if '://' in host else f'https://{host}')
        candidate = parsed.hostname or host
        if candidate and candidate not in normalized:
            normalized.append(candidate)

    return normalized or ['127.0.0.1', 'localhost']


ALLOWED_ORIGINS, ALLOW_ORIGIN_REGEX, ALLOW_ALL_ORIGINS = parse_allowed_origins(settings.allowed_origin)
TRUSTED_HOSTS = parse_trusted_hosts(settings.trusted_hosts)


def is_origin_allowed(origin: str | None) -> bool:
    # Non-browser clients may not send Origin.
    if not origin:
        return True

    if ALLOW_ALL_ORIGINS:
        return True

    if origin in ALLOWED_ORIGINS:
        return True

    if ALLOW_ORIGIN_REGEX and re.match(ALLOW_ORIGIN_REGEX, origin):
        return True

    return False


def is_websocket_origin_allowed(websocket: WebSocket) -> bool:
    return is_origin_allowed(websocket.headers.get('origin'))
