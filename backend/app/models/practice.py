from pydantic import BaseModel, Field


class PracticeResumeResponse(BaseModel):
    file_name: str
    summary: str
    chunk_count: int
    word_count: int
    stored_in_memory: bool = True


class PracticeAnswerRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    share_to_viewer: bool = False


class PracticeAnswerResponse(BaseModel):
    answer: str
    grounded: bool
    resume_file_name: str | None = None
    chunk_count: int = 0


class PracticeBroadcastRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=8000)


class PracticeBroadcastResponse(BaseModel):
    delivered: bool
    viewer_count: int


class PracticeStreamControlRequest(BaseModel):
    stream_id: str = Field(min_length=1, max_length=64)
    message: str = Field(default='Practice answer interrupted for a new question.', min_length=1, max_length=400)
