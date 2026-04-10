# Deployment Guide (Vercel + Railway)

## 1. Railway (Backend)

This repo now includes both:

- `Procfile`
- `railway.json`

Railway start command:

```bash
python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port $PORT
```

Set these Railway environment variables:

- `DEEPGRAM_API_KEY`
- `ALLOWED_ORIGIN` (comma-separated, include your Vercel domain)
- `TRUSTED_HOSTS` (comma-separated backend hostnames, include your Railway domain)
- `PRACTICE_AI_PROVIDER` (`azure`, `openai`, or `ollama`)
- `PRACTICE_AI_MODEL`
- `AZURE_OPENAI_API_KEY` (if provider is `azure`)
- `AZURE_OPENAI_ENDPOINT` (if provider is `azure`)
- `AZURE_OPENAI_DEPLOYMENT` (if provider is `azure`)
- `AZURE_OPENAI_API_VERSION` (if provider is `azure`)
- `OPENAI_API_KEY` (if provider is `openai`)
- `SESSION_TTL_MINUTES` (optional)
- `RESUME_UPLOAD_MAX_MB` (optional)
- `SESSION_CREATE_RATE_LIMIT_PER_MINUTE` (optional)

## 2. Vercel (Frontend)

This repo includes `vercel.json` so Vercel can serve pages from `frontend/`.

Recommended routes:

- `/` -> control room
- `/speaker`
- `/viewer`

## 3. First Production Check

1. Open the Vercel app root.
2. Set backend URL to your Railway public URL (for example `https://your-backend.up.railway.app`).
3. Create a session.
4. Open speaker and viewer links in different browsers/devices and confirm:
   - `/health` check passes
   - WebSocket connections stay open
   - Transcript flows from speaker to viewer

## 4. Security Before Go-Live

1. Rotate any previously exposed API keys.
2. Do not commit real `.env` values.
3. Keep `ALLOWED_ORIGIN` restricted to trusted frontend domains.
