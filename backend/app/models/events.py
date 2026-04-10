from typing import Literal
from pydantic import BaseModel


class TranscriptEvent(BaseModel):
    type: Literal['partial', 'final', 'status', 'error']
    session_id: str
    text: str
    is_final: bool = False
