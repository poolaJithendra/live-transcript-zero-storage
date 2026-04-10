from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
import re
from typing import AsyncIterator
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

from app.core.config import settings


PRACTICE_SYSTEM_PROMPT = """You are a Real-Time Interview Copilot designed to help the user clear technical interviews instantly.

The user may paste interviewer questions during a live interview. Your job is to generate answers immediately in a natural human way that does NOT sound AI-generated.

--------------------------------
PRIMARY DOMAIN FOCUS
--------------------------------

Focus mainly on these areas:

• Machine Learning  
• Generative AI (GenAI)  
• Data Science  
• Python  
• Neural Networks  
• Deep Learning  
• NLP  
• LLMs  
• RAG Systems  
• Data Engineering basics  
• Cloud AI/ML workflows  

Answers should reflect strong practical engineering knowledge in these domains.

--------------------------------
RESUME UNDERSTANDING
--------------------------------

The user will upload their resume.

You must carefully understand:
• Projects
• Technologies used
• Tools and frameworks
• Work experience
• Achievements
• Domains worked in

Use the resume as the **primary source of truth**.

When answering:

• Prefer examples from the user’s projects  
• Refer to technologies mentioned in the resume  
• Align answers with the user's experience level  

If a project is relevant, incorporate it naturally.

Example speaking style:

“In one of my projects we built a RAG-based system using Azure AI Search…”

--------------------------------
NO HALLUCINATION RULE
--------------------------------

Never invent fake projects or experiences.

If the resume does not contain a specific technology:

• Answer conceptually using general industry knowledge  
• Do NOT pretend the user implemented it  

Accuracy is more important than sounding impressive.

--------------------------------
ANSWER STYLE
--------------------------------

Responses must sound like a real engineer speaking in an interview.

Rules:

• Conversational tone  
• Practical explanations  
• No robotic structure  
• No textbook definitions  
• No bullet-heavy responses  
• Do not mention AI, prompts, or generation  

Preferred tone examples:

“Usually the way I approach this is…”

“From my experience working on ML pipelines…”

“In one of my projects…”

--------------------------------
ANSWER LENGTH
--------------------------------

Default answer length:

3–6 sentences.

For quick interview questions:

1–3 sentences.

Keep answers concise unless explicitly asked for detailed explanation.

--------------------------------
DEFINITION RULE
--------------------------------

If the interviewer asks for a definition or concept such as:

• Overfitting  
• RAG  
• Transformer  
• Gradient Descent  
• Regularization  
• Neural Networks  
• Embeddings  
• Attention  
• LLM  

Provide a **short summarized definition**.

Default length:

1–2 sentences.

Only expand if the interviewer asks follow-up questions.

--------------------------------
CODING QUESTIONS
--------------------------------

When coding questions appear:

1. Give a very short explanation.
2. Write the code.

Rules:

• Code must NOT look AI-generated  
• Use natural variable names  
• Include small comments like a developer would  
• Avoid overly perfect formatting  

Default language:

Python

Libraries allowed when relevant:

• pandas  
• numpy  
• sklearn  
• pytorch  
• tensorflow  

Structure:

short explanation → code → quick complexity comment.

--------------------------------
BEHAVIORAL QUESTIONS
--------------------------------

Answer using realistic situations.

Prefer examples from the resume projects.

Keep answers natural and believable.

Example tone:

“One challenge we had while building a machine learning pipeline was handling highly imbalanced data…”

--------------------------------
REAL-TIME INTERVIEW MODE
--------------------------------

Assume the user is in a live interview.

When the user pastes a question:

• Respond instantly  
• Do not show reasoning  
• Do not explain your thinking process  
• Return only the answer the candidate should speak  

No headings. No explanations.

--------------------------------
FINAL RULE
--------------------------------

Every answer must sound like a real candidate speaking in an interview — never like ChatGPT."""


STOPWORDS = {
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'how',
    'i', 'if', 'in', 'into', 'is', 'it', 'my', 'of', 'on', 'or', 'so', 'that',
    'the', 'their', 'there', 'these', 'this', 'to', 'we', 'what', 'when', 'which',
    'with', 'you', 'your',
}


@dataclass
class PracticeAnswerResult:
    answer: str
    chunk_count: int
    grounded: bool


def tokenize(text: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[a-zA-Z0-9+#._-]+", text.lower())
        if token not in STOPWORDS and len(token) > 1
    ]


def chunk_resume_text(text: str, max_chars: int = 900) -> list[str]:
    blocks = [block.strip() for block in re.split(r'\n\s*\n', text) if block.strip()]
    if not blocks:
        return []

    chunks: list[str] = []
    current = ''

    for block in blocks:
        candidate = f'{current}\n\n{block}'.strip() if current else block
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)

        if len(block) <= max_chars:
            current = block
            continue

        start = 0
        while start < len(block):
            chunks.append(block[start:start + max_chars].strip())
            start += max_chars - 120
        current = ''

    if current:
        chunks.append(current)

    return [chunk for chunk in chunks if chunk]


def summarize_resume(text: str, max_chars: int = 260) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    summary = ' '.join(lines[:3]).strip() if lines else text[:max_chars]
    return summary[:max_chars].rstrip() + ('...' if len(summary) > max_chars else '')


def select_relevant_chunks(question: str, chunks: list[str], limit: int = 4) -> list[str]:
    if not chunks:
        return []

    question_tokens = tokenize(question)
    if not question_tokens:
        return chunks[:limit]

    scored_chunks: list[tuple[int, str]] = []
    for chunk in chunks:
        chunk_tokens = set(tokenize(chunk))
        overlap = len(chunk_tokens.intersection(question_tokens))
        lexical_bonus = sum(1 for token in question_tokens if token in chunk.lower())
        score = overlap * 3 + lexical_bonus
        if score > 0:
            scored_chunks.append((score, chunk))

    scored_chunks.sort(key=lambda item: item[0], reverse=True)
    selected = [chunk for _, chunk in scored_chunks[:limit]]
    return selected or chunks[: min(limit, len(chunks))]


def chunk_text_for_streaming(text: str, soft_limit: int = 36) -> list[str]:
    tokens = re.findall(r'\S+\s*|\s+', text)
    if not tokens:
        return []

    chunks: list[str] = []
    current = ''

    for token in tokens:
        if current and len(current) + len(token) > soft_limit:
            chunks.append(current)
            current = token
            continue

        current += token

    if current:
        chunks.append(current)

    return chunks


class PracticeCopilotService:
    def _provider(self) -> str:
        return settings.practice_ai_provider.strip().lower()

    def _candidate_models(self) -> list[str]:
        primary_model = settings.practice_ai_model.strip()
        fallback_models = [
            model.strip()
            for model in settings.practice_ai_fallback_models.split(',')
            if model.strip()
        ]

        ordered_models: list[str] = []
        for model in [primary_model, *fallback_models]:
            if model and model not in ordered_models:
                ordered_models.append(model)

        return ordered_models or [primary_model]

    def _ollama_chat_url(self) -> str:
        base_url = settings.practice_ai_base_url.rstrip('/')
        if base_url.endswith('/v1'):
            base_url = base_url[:-3]

        parsed = urlparse(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
            raise RuntimeError('PRACTICE_AI_BASE_URL must be a valid http(s) URL.')

        return f'{base_url}/api/chat'

    def _build_generation_context(
        self,
        question: str,
        resume_chunks: list[str],
        resume_text: str | None,
    ) -> tuple[str, int, bool]:
        selected_chunks = select_relevant_chunks(question, resume_chunks)
        grounded = bool(selected_chunks or resume_text)
        resume_context = '\n\n'.join(
            f'Resume chunk {index + 1}:\n{chunk}'
            for index, chunk in enumerate(selected_chunks)
        ) if selected_chunks else 'No resume context is available for this session.'

        user_prompt = f"""Practice interview question:
{question.strip()}

Grounding context:
{resume_context}

Important:
- Use the resume context when it is relevant.
- If the resume context does not support a claim, do not invent it.
- If the question goes beyond the resume, answer conceptually and naturally.
- Return only the answer text the candidate should say."""

        return user_prompt, len(selected_chunks), grounded

    async def _generate_with_ollama(self, model_name: str, user_prompt: str) -> str:
        payload = json.dumps(
            {
                'model': model_name,
                'stream': False,
                'messages': [
                    {'role': 'system', 'content': PRACTICE_SYSTEM_PROMPT},
                    {'role': 'user', 'content': user_prompt},
                ],
                'options': {
                    'temperature': 0.35,
                    'num_predict': 700,
                },
            }
        ).encode('utf-8')

        def send_request() -> str:
            request = urllib_request.Request(
                self._ollama_chat_url(),
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            try:
                with urllib_request.urlopen(request, timeout=180) as response:  # nosec B310
                    body = response.read().decode('utf-8')
            except urllib_error.HTTPError as exc:
                detail = exc.read().decode('utf-8', errors='ignore')
                raise RuntimeError(f'Ollama returned HTTP {exc.code}: {detail or exc.reason}') from exc
            except urllib_error.URLError as exc:
                raise RuntimeError(f'Could not reach Ollama at {self._ollama_chat_url()}.') from exc

            try:
                data = json.loads(body)
            except json.JSONDecodeError as exc:
                raise RuntimeError('Ollama returned an invalid JSON response.') from exc

            message = data.get('message') or {}
            content = message.get('content')
            if not isinstance(content, str):
                raise RuntimeError('Ollama returned an empty chat message.')

            return content.strip()

        return await asyncio.to_thread(send_request)

    async def _stream_with_ollama(self, model_name: str, user_prompt: str) -> AsyncIterator[str]:
        payload = json.dumps(
            {
                'model': model_name,
                'stream': True,
                'messages': [
                    {'role': 'system', 'content': PRACTICE_SYSTEM_PROMPT},
                    {'role': 'user', 'content': user_prompt},
                ],
                'options': {
                    'temperature': 0.35,
                    'num_predict': 700,
                },
            }
        ).encode('utf-8')

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

        def emit(event_type: str, value: str = '') -> None:
            loop.call_soon_threadsafe(queue.put_nowait, (event_type, value))

        def send_request() -> None:
            request = urllib_request.Request(
                self._ollama_chat_url(),
                data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            try:
                with urllib_request.urlopen(request, timeout=180) as response:  # nosec B310
                    for raw_line in response:
                        line = raw_line.decode('utf-8').strip()
                        if not line:
                            continue

                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError as exc:
                            emit('error', f'Ollama returned an invalid streamed JSON response: {exc}')
                            return

                        if data.get('error'):
                            emit('error', str(data['error']))
                            return

                        message = data.get('message') or {}
                        content = message.get('content')
                        if isinstance(content, str) and content:
                            emit('delta', content)

                        if data.get('done'):
                            emit('done')
                            return
            except urllib_error.HTTPError as exc:
                detail = exc.read().decode('utf-8', errors='ignore')
                emit('error', f'Ollama returned HTTP {exc.code}: {detail or exc.reason}')
            except urllib_error.URLError:
                emit('error', f'Could not reach Ollama at {self._ollama_chat_url()}.')
            except Exception as exc:
                emit('error', str(exc))

        worker = asyncio.create_task(asyncio.to_thread(send_request))

        try:
            while True:
                event_type, value = await queue.get()
                if event_type == 'delta':
                    yield value
                    continue

                if event_type == 'error':
                    raise RuntimeError(value)

                if event_type == 'done':
                    break
        finally:
            await worker

    async def _generate_with_openai(self, model_name: str, user_prompt: str) -> str:
        if not settings.openai_api_key:
            raise RuntimeError('OPENAI_API_KEY is not configured for practice mode.')

        try:
            from openai import AsyncOpenAI
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "The 'openai' package is not installed. Install backend requirements or switch PRACTICE_AI_PROVIDER to 'ollama'."
            ) from exc

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.chat.completions.create(
            model=model_name,
            temperature=0.35,
            max_tokens=700,
            messages=[
                {'role': 'system', 'content': PRACTICE_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_prompt},
            ],
        )
        return (response.choices[0].message.content or '').strip()

    async def _stream_with_openai(self, model_name: str, user_prompt: str) -> AsyncIterator[str]:
        answer = await self._generate_with_openai(model_name, user_prompt)
        for chunk in chunk_text_for_streaming(answer):
            yield chunk

    async def _generate_with_azure(self, model_name: str, user_prompt: str) -> str:
        if not (settings.azure_openai_api_key and settings.azure_openai_endpoint):
            raise RuntimeError('Azure OpenAI is not configured. Set AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT.')

        try:
            from openai import AsyncAzureOpenAI
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "The 'openai' package is not installed. Install backend requirements or switch PRACTICE_AI_PROVIDER."
            ) from exc

        client = AsyncAzureOpenAI(
            api_key=settings.azure_openai_api_key,
            azure_endpoint=settings.azure_openai_endpoint,
            api_version=settings.azure_openai_api_version,
        )
        response = await client.chat.completions.create(
            model=model_name or settings.azure_openai_deployment,
            temperature=0.35,
            max_tokens=700,
            messages=[
                {'role': 'system', 'content': PRACTICE_SYSTEM_PROMPT},
                {'role': 'user', 'content': user_prompt},
            ],
        )
        return (response.choices[0].message.content or '').strip()

    async def _stream_with_azure(self, model_name: str, user_prompt: str) -> AsyncIterator[str]:
        if not (settings.azure_openai_api_key and settings.azure_openai_endpoint):
            raise RuntimeError('Azure OpenAI is not configured. Set AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT.')

        try:
            from openai import AsyncAzureOpenAI
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "The 'openai' package is not installed. Install backend requirements or switch PRACTICE_AI_PROVIDER."
            ) from exc

        client = AsyncAzureOpenAI(
            api_key=settings.azure_openai_api_key,
            azure_endpoint=settings.azure_openai_endpoint,
            api_version=settings.azure_openai_api_version,
        )

        try:
            stream = await client.chat.completions.create(
                model=model_name or settings.azure_openai_deployment,
                temperature=0.35,
                max_tokens=700,
                stream=True,
                messages=[
                    {'role': 'system', 'content': PRACTICE_SYSTEM_PROMPT},
                    {'role': 'user', 'content': user_prompt},
                ],
            )
        except Exception as exc:  # network or auth errors
            raise RuntimeError(f'Azure OpenAI request failed: {exc}') from exc

        async for chunk in stream:
            for choice in chunk.choices or []:
                delta = getattr(choice, 'delta', None) or {}
                content = getattr(delta, 'content', None)
                if not content:
                    continue
                if isinstance(content, str):
                    yield content
                    continue
                if isinstance(content, list):
                    text_parts: list[str] = []
                    for part in content:
                        # support both dict-like and object-like parts
                        text = getattr(part, 'text', None) or (part.get('text') if isinstance(part, dict) else None)
                        if text:
                            text_parts.append(text)
                    if text_parts:
                        yield ''.join(text_parts)

    async def stream_answer(
        self,
        question: str,
        resume_chunks: list[str],
        resume_text: str | None,
    ) -> tuple[int, bool, AsyncIterator[str]]:
        user_prompt, chunk_count, grounded = self._build_generation_context(question, resume_chunks, resume_text)
        provider = self._provider()
        if provider == 'ollama':
            models_to_try = self._candidate_models()
        elif provider in {'azure', 'azure-openai', 'azure_openai'}:
            azure_model = settings.azure_openai_deployment.strip() or settings.practice_ai_model.strip()
            models_to_try = [azure_model]
        else:
            models_to_try = [settings.practice_ai_model.strip()]

        async def generator() -> AsyncIterator[str]:
            last_error: str | None = None

            for model_name in models_to_try:
                emitted_any = False
                try:
                    if provider == 'ollama':
                        stream = self._stream_with_ollama(model_name, user_prompt)
                    elif provider == 'openai':
                        stream = self._stream_with_openai(model_name, user_prompt)
                    elif provider in {'azure', 'azure-openai', 'azure_openai'}:
                        stream = self._stream_with_azure(model_name, user_prompt)
                    else:
                        raise RuntimeError(
                            "Unsupported PRACTICE_AI_PROVIDER. Use 'ollama', 'openai', or 'azure'."
                        )

                    async for chunk in stream:
                        if chunk:
                            emitted_any = True
                            yield chunk

                    if emitted_any:
                        return

                    last_error = f'{model_name} returned an empty response.'
                except RuntimeError as error:
                    if emitted_any:
                        raise RuntimeError(str(error)) from error
                    last_error = f'{model_name} failed: {error}'

            if provider == 'ollama':
                tried = ', '.join(models_to_try)
                detail = last_error or 'No local model returned a response.'
                raise RuntimeError(f'Ollama practice generation failed after trying {tried}. {detail}')

            raise RuntimeError(last_error or 'The practice model returned an empty response.')

        return chunk_count, grounded, generator()

    async def generate_answer(self, question: str, resume_chunks: list[str], resume_text: str | None) -> PracticeAnswerResult:
        chunk_count, grounded, answer_stream = await self.stream_answer(question, resume_chunks, resume_text)
        answer_parts: list[str] = []

        async for chunk in answer_stream:
            answer_parts.append(chunk)

        answer = ''.join(answer_parts).strip()
        if not answer:
            raise RuntimeError('The practice model returned an empty response.')

        return PracticeAnswerResult(
            answer=answer,
            chunk_count=chunk_count,
            grounded=grounded,
        )


practice_copilot = PracticeCopilotService()
