from pydantic import BaseModel


class SessionCreateResponse(BaseModel):
    session_id: str
    speaker_token: str
    viewer_token: str
    expires_in_minutes: int
