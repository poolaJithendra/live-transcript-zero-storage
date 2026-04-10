from collections import defaultdict, deque
from time import monotonic

from fastapi import APIRouter, HTTPException, Request

from app.core.config import settings
from app.models.sessions import SessionCreateResponse
from app.services.session_manager import session_manager

router = APIRouter()
SESSION_RATE_LIMIT_WINDOW_SECONDS = 60.0
_session_creation_events: dict[str, deque[float]] = defaultdict(deque)


def _resolve_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get('x-forwarded-for', '')
    if forwarded_for:
        return forwarded_for.split(',')[0].strip() or 'unknown'

    if request.client and request.client.host:
        return request.client.host

    return 'unknown'


def _enforce_session_create_rate_limit(client_ip: str) -> None:
    limit = settings.session_create_rate_limit_per_minute
    now = monotonic()
    min_allowed_time = now - SESSION_RATE_LIMIT_WINDOW_SECONDS
    attempts = _session_creation_events[client_ip]

    while attempts and attempts[0] < min_allowed_time:
        attempts.popleft()

    if len(attempts) >= limit:
        raise HTTPException(
            status_code=429,
            detail='Too many session creation requests. Please wait and retry in about one minute.',
        )

    attempts.append(now)


@router.post('/sessions', response_model=SessionCreateResponse)
async def create_session(request: Request) -> SessionCreateResponse:
    _enforce_session_create_rate_limit(_resolve_client_ip(request))
    session_id, speaker_token, viewer_token = session_manager.create_session()
    return SessionCreateResponse(
        session_id=session_id,
        speaker_token=speaker_token,
        viewer_token=viewer_token,
        expires_in_minutes=settings.session_ttl_minutes,
    )
