from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.models.events import TranscriptEvent
from app.core.security import is_websocket_origin_allowed
from app.services.deepgram_stream import DeepgramBridge
from app.services.session_manager import session_manager

router = APIRouter()


@router.websocket('/ws/view/{session_id}')
async def viewer_ws(websocket: WebSocket, session_id: str) -> None:
    if not is_websocket_origin_allowed(websocket):
        await websocket.close(code=1008, reason='Origin not allowed')
        return

    token = websocket.query_params.get('token')
    if not session_manager.validate_token(session_id, token, role='viewer'):
        await websocket.close(code=1008, reason='Invalid viewer token')
        return

    await websocket.accept()
    await session_manager.add_viewer(session_id, websocket)
    await websocket.send_json(
        TranscriptEvent(
            type='status',
            session_id=session_id,
            text='Viewer connected',
            is_final=False,
        ).model_dump()
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await session_manager.remove_viewer(session_id, websocket)
    except Exception:
        await session_manager.remove_viewer(session_id, websocket)
        await websocket.close()


@router.websocket('/ws/speak/{session_id}')
async def speaker_ws(websocket: WebSocket, session_id: str) -> None:
    if not is_websocket_origin_allowed(websocket):
        await websocket.close(code=1008, reason='Origin not allowed')
        return

    token = websocket.query_params.get('token')
    if not session_manager.validate_token(session_id, token, role='speaker'):
        await websocket.close(code=1008, reason='Invalid speaker token')
        return

    await websocket.accept()
    speaker_registered = False

    async def handle_deepgram_message(payload: dict) -> None:
        channel = payload.get('channel', {})
        alternatives = channel.get('alternatives', [])
        text = alternatives[0].get('transcript', '').strip() if alternatives else ''
        if not text:
            return

        is_final = bool(payload.get('is_final'))
        event = TranscriptEvent(
            type='final' if is_final else 'partial',
            session_id=session_id,
            text=text,
            is_final=is_final,
        )
        await session_manager.broadcast_json(session_id, event.model_dump())
        if websocket.client_state.name == 'CONNECTED':
            await websocket.send_json(event.model_dump())

    bridge = DeepgramBridge(on_transcript=handle_deepgram_message)
    try:
        await session_manager.register_speaker(session_id, websocket)
        speaker_registered = True
        await bridge.connect()
        await websocket.send_json(
            TranscriptEvent(
                type='status',
                session_id=session_id,
                text='Speaker connected',
                is_final=False,
            ).model_dump()
        )

        while True:
            message = await websocket.receive()
            if message.get('type') == 'websocket.disconnect':
                break

            if message.get('bytes'):
                await bridge.send_audio(message['bytes'])
            elif message.get('text') == 'STOP':
                await bridge.finish()
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        await session_manager.broadcast_json(
            session_id,
            TranscriptEvent(
                type='error',
                session_id=session_id,
                text='Unable to start transcription stream.',
                is_final=True,
            ).model_dump(),
        )
        if websocket.client_state.name == 'CONNECTED':
            await websocket.send_json(
                TranscriptEvent(
                    type='error',
                    session_id=session_id,
                    text='Unable to start transcription stream.',
                    is_final=True,
                ).model_dump()
            )
    finally:
        await bridge.close()
        if speaker_registered:
            await session_manager.broadcast_json(
                session_id,
                TranscriptEvent(
                    type='status',
                    session_id=session_id,
                    text='Session ended. Nothing was stored.',
                    is_final=True,
                ).model_dump(),
            )
            await session_manager.unregister_speaker(session_id, websocket)
        if websocket.client_state.name == 'CONNECTED':
            await websocket.close()
