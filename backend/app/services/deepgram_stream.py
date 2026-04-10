from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable
from urllib.parse import urlencode

import websockets
from websockets.client import ClientConnection

from app.core.config import settings


class DeepgramBridge:
    def __init__(self, on_transcript: Callable[[dict], Awaitable[None]]) -> None:
        self.on_transcript = on_transcript
        self.websocket: ClientConnection | None = None
        self.reader_task: asyncio.Task | None = None
        self.keepalive_task: asyncio.Task | None = None

    async def connect(self) -> None:
        params = urlencode(
            {
                'model': settings.deepgram_model,
                'language': settings.deepgram_language,
                'interim_results': 'true',
                'smart_format': 'true',
                'punctuate': 'true',
                'encoding': 'linear16',
                'sample_rate': str(settings.sample_rate),
                'channels': str(settings.channels),
                'endpointing': '300',
            }
        )
        url = f'wss://api.deepgram.com/v1/listen?{params}'
        self.websocket = await websockets.connect(
            url,
            additional_headers={'Authorization': f'Token {settings.deepgram_api_key}'},
            ping_interval=20,
            ping_timeout=20,
            max_size=10_000_000,
        )
        self.reader_task = asyncio.create_task(self._reader())
        self.keepalive_task = asyncio.create_task(self._keepalive())

    async def send_audio(self, audio_bytes: bytes) -> None:
        if not self.websocket:
            raise RuntimeError('Deepgram socket is not connected')
        await self.websocket.send(audio_bytes)

    async def finish(self) -> None:
        if self.websocket:
            try:
                await self.websocket.send(json.dumps({'type': 'CloseStream'}))
            except Exception:
                return

    async def close(self) -> None:
        for task in (self.keepalive_task, self.reader_task):
            if task:
                task.cancel()
        if self.websocket:
            try:
                await self.websocket.close()
            except Exception:
                return

    async def _reader(self) -> None:
        if self.websocket is None:
            raise RuntimeError('Deepgram reader started without an active websocket.')
        async for message in self.websocket:
            if isinstance(message, bytes):
                continue
            payload = json.loads(message)
            await self.on_transcript(payload)

    async def _keepalive(self) -> None:
        if self.websocket is None:
            raise RuntimeError('Deepgram keepalive started without an active websocket.')
        while True:
            await asyncio.sleep(8)
            try:
                await self.websocket.send(json.dumps({'type': 'KeepAlive'}))
            except Exception:
                return
