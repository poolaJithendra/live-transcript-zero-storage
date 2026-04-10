from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=[
            '.env',
            'backend/.env',
            str(Path(__file__).resolve().parents[2] / 'backend' / '.env'),
        ],
        env_file_encoding='utf-8',
        extra='ignore',
    )

    app_name: str = 'Live Transcript Zero Storage'
    deepgram_api_key: str = Field(alias='DEEPGRAM_API_KEY')
    openai_api_key: str | None = Field(default=None, alias='OPENAI_API_KEY')
    azure_openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices('AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_KEY'),
    )
    azure_openai_endpoint: str | None = Field(
        default=None,
        validation_alias=AliasChoices('AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_ENDPOINT_URL'),
    )
    azure_openai_deployment: str = Field(
        default='gpt-4.1',
        validation_alias=AliasChoices('AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_MODEL', 'PRACTICE_AI_MODEL'),
    )
    azure_openai_api_version: str = Field(
        default='2025-01-01-preview',
        validation_alias=AliasChoices('AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_VERSION'),
    )
    allowed_origin: str = Field(default='http://127.0.0.1:5500', alias='ALLOWED_ORIGIN')
    trusted_hosts: str = Field(default='127.0.0.1,localhost', alias='TRUSTED_HOSTS')
    session_ttl_minutes: int = Field(default=240, alias='SESSION_TTL_MINUTES', ge=5, le=1440)
    resume_upload_max_mb: int = Field(default=8, alias='RESUME_UPLOAD_MAX_MB', ge=1, le=50)
    session_create_rate_limit_per_minute: int = Field(
        default=60,
        alias='SESSION_CREATE_RATE_LIMIT_PER_MINUTE',
        ge=1,
        le=600,
    )
    practice_ai_provider: str = Field(default='ollama', alias='PRACTICE_AI_PROVIDER')
    practice_ai_model: str = Field(default='llama3.1:8b', alias='PRACTICE_AI_MODEL')
    practice_ai_fallback_models: str = Field(
        default='llama3:latest,llama3.2:3b,qwen2.5:7b,gemma3:4b',
        alias='PRACTICE_AI_FALLBACK_MODELS',
    )
    practice_ai_base_url: str = Field(default='http://127.0.0.1:11434/v1', alias='PRACTICE_AI_BASE_URL')
    deepgram_model: str = 'nova-3'
    deepgram_language: str = 'en'
    sample_rate: int = 16000
    channels: int = 1


settings = Settings()
