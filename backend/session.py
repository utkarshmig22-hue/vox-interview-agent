import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from threading import Lock
from typing import Optional

from . import db
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
    custom_persona_name: Optional[str] = None
    custom_persona_prompt: Optional[str] = None
    adaptive_difficulty: bool = True
    turns: list[Turn] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    primary_questions_asked: int = 0
    finished: bool = False
    last_speaker: Optional[str] = None
    started_at: Optional[float] = None
    # Per-turn response timing (ms). Index aligns with turns list.
    turn_response_ms: list[int] = field(default_factory=list)
    # Cached report after finish (for re-rendering on Resume).
    _report: Optional[dict] = None

    def add_turn(self, role: str, content: str) -> None:
        self.turns.append(Turn(role=role, content=content))
        if self.started_at is None:
            self.started_at = time.time()

    def elapsed_minutes(self) -> float:
        if not self.started_at:
            return 0.0
        return (time.time() - self.started_at) / 60.0

    def time_remaining_minutes(self) -> float:
        return max(0.0, self.target_minutes - self.elapsed_minutes())

    def to_dict(self) -> dict:
        d = asdict(self)
        d["turns"] = [t if isinstance(t, dict) else (t.model_dump() if hasattr(t, "model_dump") else t) for t in self.turns]
        # Pydantic Turn models become dicts via asdict on the wrapper; but if Turn is BaseModel asdict fails.
        # Re-serialise turns from the actual objects.
        d["turns"] = [
            {"role": t.role, "content": t.content} if hasattr(t, "role") else t
            for t in self.turns
        ]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "InterviewSession":
        # Reconstruct Turn objects
        turns_data = d.pop("turns", []) or []
        # Strip pydantic-incompatible private fields when constructing
        s = cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})
        s.turns = [Turn(**t) if isinstance(t, dict) else t for t in turns_data]
        return s


class SessionStore:
    """Persistent session store backed by SQLite. Sessions are kept in an
    in-memory cache for fast access but written through on every mutation
    so a restart doesn't lose progress."""

    def __init__(self) -> None:
        self._cache: dict[str, InterviewSession] = {}
        self._lock = Lock()
        db.init()

    def _persist(self, session: InterviewSession) -> None:
        db.upsert_session(
            session.id,
            session.to_dict(),
            finished=session.finished,
            topic=session.topic or "",
            mode=session.mode or "job",
        )

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
        custom_persona_name: Optional[str] = None,
        custom_persona_prompt: Optional[str] = None,
        adaptive_difficulty: bool = True,
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
            custom_persona_name=custom_persona_name,
            custom_persona_prompt=custom_persona_prompt,
            adaptive_difficulty=adaptive_difficulty,
            started_at=None,
        )
        with self._lock:
            self._cache[session_id] = session
        self._persist(session)
        return session

    def get(self, session_id: str) -> Optional[InterviewSession]:
        with self._lock:
            if session_id in self._cache:
                return self._cache[session_id]
        # Try loading from DB (server restart case)
        d = db.get_session(session_id)
        if not d:
            return None
        s = InterviewSession.from_dict(d)
        with self._lock:
            self._cache[session_id] = s
        return s

    def save(self, session: InterviewSession) -> None:
        """Caller invokes after mutating a session — writes through to DB."""
        with self._lock:
            self._cache[session.id] = session
        self._persist(session)

    def drop(self, session_id: str) -> None:
        with self._lock:
            self._cache.pop(session_id, None)
        db.delete_session(session_id)


store = SessionStore()
