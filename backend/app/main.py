from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.core.config import settings
from app.core.security import ALLOWED_ORIGINS, ALLOW_ALL_ORIGINS, ALLOW_ORIGIN_REGEX, TRUSTED_HOSTS
from app.routers.health import router as health_router
from app.routers.practice import router as practice_router
from app.routers.realtime import router as realtime_router
from app.routers.sessions import router as sessions_router

app = FastAPI(title=settings.app_name)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=TRUSTED_HOSTS,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOW_ORIGIN_REGEX,
    allow_credentials=not ALLOW_ALL_ORIGINS,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(health_router)
app.include_router(practice_router)
app.include_router(sessions_router)
app.include_router(realtime_router)
