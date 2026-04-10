from __future__ import annotations

import asyncio
import json
import secrets

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.models.practice import (
    PracticeAnswerRequest,
    PracticeAnswerResponse,
    PracticeBroadcastRequest,
    PracticeBroadcastResponse,
    PracticeResumeResponse,
    PracticeStreamControlRequest,
)
from app.services.practice_copilot import (
    chunk_resume_text,
    chunk_text_for_streaming,
    practice_copilot,
    summarize_resume,
)
from app.services.resume_ingest import extract_resume_text
from app.services.session_manager import session_manager

router = APIRouter()


def require_speaker_access(session_id: str, session_token: str | None) -> None:
    if not session_manager.validate_token(session_id, session_token, role='speaker'):
        raise HTTPException(status_code=403, detail='Invalid speaker token.')


def encode_stream_event(payload: dict) -> bytes:
    return (json.dumps(payload) + '\n').encode('utf-8')


async def broadcast_streamed_answer(
    session_id: str,
    stream_id: str,
    answer: str,
    *,
    delay_seconds: float | None = None,
) -> int:
    viewer_count = session_manager.viewer_count(session_id)
    if viewer_count <= 0:
        return 0
    effective_delay = settings.practice_stream_delay_seconds if delay_seconds is None else delay_seconds

    await session_manager.broadcast_json(
        session_id,
        {
            'type': 'practice_answer_start',
            'stream_id': stream_id,
        },
    )

    for chunk in chunk_text_for_streaming(answer):
        await session_manager.broadcast_json(
            session_id,
            {
                'type': 'practice_answer_delta',
                'stream_id': stream_id,
                'text': chunk,
            },
        )
        if effective_delay > 0:
            await asyncio.sleep(effective_delay)

    await session_manager.broadcast_json(
        session_id,
        {
            'type': 'practice_answer_done',
            'stream_id': stream_id,
            'text': answer,
        },
    )

    return viewer_count


@router.post('/practice/{session_id}/resume', response_model=PracticeResumeResponse)
async def upload_resume(
    session_id: str,
    resume_file: UploadFile = File(...),
    x_session_token: str | None = Header(default=None, alias='X-Session-Token'),
) -> PracticeResumeResponse:
    require_speaker_access(session_id, x_session_token)

    file_bytes = await resume_file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail='Resume upload was empty.')

    max_bytes = settings.resume_upload_max_mb * 1024 * 1024
    if len(file_bytes) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f'Resume file is too large. Keep it under {settings.resume_upload_max_mb} MB.',
        )

    try:
        text = await asyncio.to_thread(
            extract_resume_text,
            resume_file.filename or 'resume',
            resume_file.content_type,
            file_bytes,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=400, detail='Unable to extract text from the uploaded resume.') from error

    if len(text.split()) < 30:
        raise HTTPException(status_code=400, detail='The uploaded resume did not contain enough readable text.')

    chunks = chunk_resume_text(text)
    context = session_manager.set_resume_context(
        session_id,
        file_name=resume_file.filename or 'resume',
        text=text,
        chunks=chunks,
        summary=summarize_resume(text),
        word_count=len(text.split()),
    )

    return PracticeResumeResponse(
        file_name=context.file_name,
        summary=context.summary,
        chunk_count=len(context.chunks),
        word_count=context.word_count,
    )


@router.post('/practice/{session_id}/answer', response_model=PracticeAnswerResponse)
async def generate_practice_answer(
    session_id: str,
    payload: PracticeAnswerRequest,
    x_session_token: str | None = Header(default=None, alias='X-Session-Token'),
) -> PracticeAnswerResponse:
    require_speaker_access(session_id, x_session_token)

    resume_context = session_manager.get_resume_context(session_id)
    try:
        result = await practice_copilot.generate_answer(
            payload.question,
            resume_context.chunks if resume_context else [],
            resume_context.text if resume_context else None,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail='Practice answer generation failed.') from error

    return PracticeAnswerResponse(
        answer=result.answer,
        grounded=result.grounded,
        resume_file_name=resume_context.file_name if resume_context else None,
        chunk_count=result.chunk_count,
    )


@router.post('/practice/{session_id}/answer-stream')
async def stream_practice_answer(
    session_id: str,
    payload: PracticeAnswerRequest,
    x_session_token: str | None = Header(default=None, alias='X-Session-Token'),
) -> StreamingResponse:
    require_speaker_access(session_id, x_session_token)

    resume_context = session_manager.get_resume_context(session_id)
    resume_file_name = resume_context.file_name if resume_context else None
    stream_id = secrets.token_hex(6)
    viewer_count = session_manager.viewer_count(session_id) if payload.share_to_viewer else 0

    async def event_stream():
        try:
            chunk_count, grounded, answer_stream = await practice_copilot.stream_answer(
                payload.question,
                resume_context.chunks if resume_context else [],
                resume_context.text if resume_context else None,
            )
        except RuntimeError as error:
            yield encode_stream_event({'type': 'error', 'detail': str(error)})
            return
        except Exception:
            yield encode_stream_event({'type': 'error', 'detail': 'Practice answer generation failed.'})
            return

        yield encode_stream_event(
            {
                'type': 'start',
                'stream_id': stream_id,
                'grounded': grounded,
                'chunk_count': chunk_count,
                'resume_file_name': resume_file_name,
                'viewer_count': viewer_count,
            }
        )

        if payload.share_to_viewer and viewer_count > 0:
            await session_manager.broadcast_json(
                session_id,
                {
                    'type': 'practice_answer_start',
                    'stream_id': stream_id,
                },
            )

        answer_parts: list[str] = []

        try:
            async for chunk in answer_stream:
                answer_parts.append(chunk)
                yield encode_stream_event({'type': 'delta', 'text': chunk})

                if payload.share_to_viewer and viewer_count > 0:
                    await session_manager.broadcast_json(
                        session_id,
                        {
                            'type': 'practice_answer_delta',
                            'stream_id': stream_id,
                            'text': chunk,
                        },
                    )
                if settings.practice_stream_delay_seconds > 0:
                    await asyncio.sleep(settings.practice_stream_delay_seconds)
        except RuntimeError as error:
            if payload.share_to_viewer and viewer_count > 0:
                await session_manager.broadcast_json(
                    session_id,
                    {
                        'type': 'practice_answer_error',
                        'stream_id': stream_id,
                        'text': str(error),
                    },
                )
            yield encode_stream_event({'type': 'error', 'detail': str(error)})
            return
        except Exception:
            if payload.share_to_viewer and viewer_count > 0:
                await session_manager.broadcast_json(
                    session_id,
                    {
                        'type': 'practice_answer_error',
                        'stream_id': stream_id,
                        'text': 'Practice answer generation failed.',
                    },
                )
            yield encode_stream_event({'type': 'error', 'detail': 'Practice answer generation failed.'})
            return

        answer = ''.join(answer_parts).strip()
        if not answer:
            yield encode_stream_event({'type': 'error', 'detail': 'The practice model returned an empty response.'})
            return

        if payload.share_to_viewer and viewer_count > 0:
            await session_manager.broadcast_json(
                session_id,
                {
                    'type': 'practice_answer_done',
                    'stream_id': stream_id,
                    'text': answer,
                },
            )

        yield encode_stream_event(
            {
                'type': 'done',
                'stream_id': stream_id,
                'answer': answer,
                'grounded': grounded,
                'resume_file_name': resume_file_name,
                'chunk_count': chunk_count,
                'viewer_count': viewer_count,
            }
        )

    return StreamingResponse(event_stream(), media_type='application/x-ndjson')


@router.post('/practice/{session_id}/broadcast-answer', response_model=PracticeBroadcastResponse)
async def broadcast_practice_answer(
    session_id: str,
    payload: PracticeBroadcastRequest,
    x_session_token: str | None = Header(default=None, alias='X-Session-Token'),
) -> PracticeBroadcastResponse:
    require_speaker_access(session_id, x_session_token)

    answer = payload.answer.strip()
    viewer_count = await broadcast_streamed_answer(session_id, secrets.token_hex(6), answer)

    return PracticeBroadcastResponse(
        delivered=viewer_count > 0,
        viewer_count=viewer_count,
    )


@router.post('/practice/{session_id}/cancel-stream', response_model=PracticeBroadcastResponse)
async def cancel_practice_stream(
    session_id: str,
    payload: PracticeStreamControlRequest,
    x_session_token: str | None = Header(default=None, alias='X-Session-Token'),
) -> PracticeBroadcastResponse:
    require_speaker_access(session_id, x_session_token)

    viewer_count = session_manager.viewer_count(session_id)
    if viewer_count > 0:
        await session_manager.broadcast_json(
            session_id,
            {
                'type': 'practice_answer_error',
                'stream_id': payload.stream_id,
                'text': payload.message,
            },
        )

    return PracticeBroadcastResponse(
        delivered=viewer_count > 0,
        viewer_count=viewer_count,
    )
