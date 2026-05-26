import uuid
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional

import time

from .models import Difficulty, InterviewMode, InterviewStyle, Persona, Turn


@dataclass
class InterviewSession:
    id: str
    topic: str
    difficulty: Difficulty
    target_questions: int
    candidate_name: Optional[str]
    role_context: Optional[str] = None
    focus_areas: Optional[str] = None
    candidate_background: Optional[str] = None
    scenarios_to_cover: Optional[str] = None
    interview_style: InterviewStyle = "mixed"
    persona: Persona = "hiring-manager"
    small_talk: bool = False
    target_minutes: int = 15
    mode: InterviewMode = "job"
    study_material: Optional[str] = None
    turns: list[Turn] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)        # internal interviewer observations
    primary_questions_asked: int = 0
    finished: bool = False
    started_at: float = field(default_factory=time.time)
    last_speaker: Optional[str] = None                    # for panel mode

    def add_turn(self, role: str, content: str) -> None:
        self.turns.append(Turn(role=role, content=content))

    def elapsed_minutes(self) -> float:
        return (time.time() - self.started_at) / 60.0

    def time_remaining_minutes(self) -> float:
        return max(0.0, self.target_minutes - self.elapsed_minutes())


class SessionStore:
    """In-memory session store. Thread-safe enough for a single-process demo."""

    def __init__(self) -> None:
        self._sessions: dict[str, InterviewSession] = {}
        self._lock = Lock()

    def create(
        self,
        topic: str,
        difficulty: Difficulty,
        target_questions: int,
        candidate_name: Optional[str],
        role_context: Optional[str] = None,
        focus_areas: Optional[str] = None,
        candidate_background: Optional[str] = None,
        scenarios_to_cover: Optional[str] = None,
        interview_style: InterviewStyle = "mixed",
        persona: Persona = "hiring-manager",
        small_talk: bool = False,
        target_minutes: int = 15,
        mode: InterviewMode = "job",
        study_material: Optional[str] = None,
    ) -> InterviewSession:
        session_id = uuid.uuid4().hex[:12]
        session = InterviewSession(
            id=session_id,
            topic=topic,
            difficulty=difficulty,
            target_questions=target_questions,
            candidate_name=candidate_name,
            role_context=role_context,
            focus_areas=focus_areas,
            candidate_background=candidate_background,
            scenarios_to_cover=scenarios_to_cover,
            interview_style=interview_style,
            persona=persona,
            small_talk=small_talk,
            target_minutes=target_minutes,
            mode=mode,
            study_material=study_material,
        )
        with self._lock:
            self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Optional[InterviewSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def drop(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)


store = SessionStore()
