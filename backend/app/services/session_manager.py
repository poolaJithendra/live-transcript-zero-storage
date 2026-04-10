from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import secrets
from typing import Dict, Set

from fastapi import WebSocket

from app.core.config import settings


@dataclass
class SessionCredentials:
    speaker_token: str
    viewer_token: str
    expires_at: datetime


@dataclass
class PracticeResumeContext:
    file_name: str
    text: str
    chunks: list[str]
    summary: str
    word_count: int
    updated_at: datetime


class SessionManager:
    def __init__(self) -> None:
        self._viewer_sockets: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._speaker_sockets: Dict[str, WebSocket] = {}
        self._session_credentials: Dict[str, SessionCredentials] = {}
        self._practice_resume_contexts: Dict[str, PracticeResumeContext] = {}
        self._locks: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def _expires_at(self) -> datetime:
        return datetime.now(timezone.utc) + timedelta(minutes=settings.session_ttl_minutes)

    def _prune_expired_sessions(self) -> None:
        now = datetime.now(timezone.utc)
        expired = [
            session_id
            for session_id, credentials in self._session_credentials.items()
            if credentials.expires_at <= now
        ]
        for session_id in expired:
            self._session_credentials.pop(session_id, None)
            self._practice_resume_contexts.pop(session_id, None)
            if session_id not in self._speaker_sockets and session_id not in self._viewer_sockets:
                self._locks.pop(session_id, None)

    def _touch_session(self, session_id: str) -> None:
        credentials = self._session_credentials.get(session_id)
        if credentials:
            credentials.expires_at = self._expires_at()

    def create_session(self) -> tuple[str, str, str]:
        self._prune_expired_sessions()

        while True:
            session_id = secrets.token_hex(6)
            if session_id not in self._session_credentials:
                break

        speaker_token = secrets.token_urlsafe(24)
        viewer_token = secrets.token_urlsafe(24)
        self._session_credentials[session_id] = SessionCredentials(
            speaker_token=speaker_token,
            viewer_token=viewer_token,
            expires_at=self._expires_at(),
        )
        self._locks.setdefault(session_id, asyncio.Lock())
        return session_id, speaker_token, viewer_token

    def set_resume_context(
        self,
        session_id: str,
        *,
        file_name: str,
        text: str,
        chunks: list[str],
        summary: str,
        word_count: int,
    ) -> PracticeResumeContext:
        context = PracticeResumeContext(
            file_name=file_name,
            text=text,
            chunks=chunks,
            summary=summary,
            word_count=word_count,
            updated_at=datetime.now(timezone.utc),
        )
        self._practice_resume_contexts[session_id] = context
        self._touch_session(session_id)
        return context

    def get_resume_context(self, session_id: str) -> PracticeResumeContext | None:
        self._prune_expired_sessions()
        context = self._practice_resume_contexts.get(session_id)
        if context:
            context.updated_at = datetime.now(timezone.utc)
            self._touch_session(session_id)
        return context

    def validate_token(self, session_id: str, token: str | None, role: str) -> bool:
        self._prune_expired_sessions()
        credentials = self._session_credentials.get(session_id)
        if not credentials or not token:
            return False

        expected = credentials.speaker_token if role == 'speaker' else credentials.viewer_token
        is_valid = secrets.compare_digest(token, expected)
        if is_valid:
            self._touch_session(session_id)
        return is_valid

    async def register_speaker(self, session_id: str, websocket: WebSocket) -> None:
        async with self._locks[session_id]:
            old_socket = self._speaker_sockets.get(session_id)
            if old_socket and old_socket is not websocket:
                await old_socket.close(code=4001, reason='Another speaker connected')
            self._speaker_sockets[session_id] = websocket
            self._touch_session(session_id)

    async def unregister_speaker(self, session_id: str, websocket: WebSocket) -> None:
        async with self._locks[session_id]:
            if self._speaker_sockets.get(session_id) is websocket:
                self._speaker_sockets.pop(session_id, None)
            if not self._viewer_sockets.get(session_id) and session_id not in self._session_credentials:
                self._locks.pop(session_id, None)

    async def add_viewer(self, session_id: str, websocket: WebSocket) -> None:
        self._viewer_sockets[session_id].add(websocket)
        self._touch_session(session_id)

    async def remove_viewer(self, session_id: str, websocket: WebSocket) -> None:
        viewers = self._viewer_sockets.get(session_id)
        if not viewers:
            return
        viewers.discard(websocket)
        if not viewers:
            self._viewer_sockets.pop(session_id, None)
            if session_id not in self._speaker_sockets and session_id not in self._session_credentials:
                self._locks.pop(session_id, None)

    async def broadcast_json(self, session_id: str, payload: dict) -> None:
        viewers = list(self._viewer_sockets.get(session_id, set()))
        if not viewers:
            return

        self._touch_session(session_id)

        stale: list[WebSocket] = []
        for websocket in viewers:
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)

        for websocket in stale:
            await self.remove_viewer(session_id, websocket)

    def viewer_count(self, session_id: str) -> int:
        return len(self._viewer_sockets.get(session_id, set()))


session_manager = SessionManager()
