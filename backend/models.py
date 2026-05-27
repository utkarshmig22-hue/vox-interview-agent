from typing import Literal, Optional
from pydantic import BaseModel, Field


Difficulty = Literal["beginner", "intermediate", "advanced", "expert"]
Role = Literal["interviewer", "candidate"]
InterviewStyle = Literal[
    "conversational",
    "structured-behavioral",
    "case-study",
    "technical-deep-dive",
    "mixed",
]
Persona = Literal[
    "friendly-mentor",
    "skeptical-senior",
    "hiring-manager",
    "panel",
    "custom",
]
InterviewMode = Literal["job", "study"]


class StartInterviewRequest(BaseModel):
    topic: str = Field(..., min_length=2, max_length=200,
                       description="Free-form topic, e.g. 'Python backend engineering' or 'Behavioural - leadership'")
    difficulty: Difficulty = "intermediate"
    candidate_name: Optional[str] = None
    target_questions: int = Field(6, ge=3, le=15,
                                  description="How many primary questions before wrapping up")

    # ---- Optional rich context ----
    role_context: Optional[str] = Field(
        None, max_length=1000,
        description="Target role / company / level, e.g. 'Senior PM at a B2B SaaS fintech (Series B)'.",
    )
    focus_areas: Optional[str] = Field(
        None, max_length=1000,
        description="What to test the candidate on, e.g. 'prioritisation, metrics, stakeholder management, technical fluency'.",
    )
    candidate_background: Optional[str] = Field(
        None, max_length=3000,
        description="Candidate's background / resume highlights, so the interviewer can tailor questions.",
    )
    scenarios_to_cover: Optional[str] = Field(
        None, max_length=2000,
        description="Specific situations, cases, or themes the user wants to be tested on.",
    )
    interview_style: InterviewStyle = "mixed"
    persona: Persona = "hiring-manager"
    small_talk: bool = False
    target_minutes: int = Field(15, ge=5, le=60,
                                description="Soft time budget in minutes. Used to nudge wrap-up.")

    # ---- Mode ----
    mode: InterviewMode = "job"
    study_material: Optional[str] = Field(
        None, max_length=80000,
        description="Study-mode only: the source text (extracted from a PDF/DOCX/notes upload). "
                    "Questions will be grounded in this material.",
    )

    # ---- Custom persona + adaptive difficulty ----
    custom_persona_name: Optional[str] = Field(None, max_length=80)
    custom_persona_prompt: Optional[str] = Field(None, max_length=2000)
    adaptive_difficulty: bool = Field(
        True,
        description="If true, the interviewer ramps difficulty up/down based on answer quality.",
    )

    # ---- Custom evaluation criteria (overrides the default 5) ----
    custom_criteria: Optional[list[str]] = Field(
        None,
        description="Optional list of evaluation criterion names to use INSTEAD of the defaults. "
                    "e.g. ['Storytelling craft', 'Technical specificity', 'Reflective depth'].",
    )


class RespondRequestExt(BaseModel):
    """Extended respond request that lets the frontend report how long the
    candidate took to answer (for speed-of-thought scoring)."""
    answer: str = Field(..., min_length=1, max_length=8000)
    response_time_ms: Optional[int] = Field(None, ge=0, le=10 * 60 * 1000)


class CommentRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=2000)
    author: Optional[str] = Field(None, max_length=80)
    turn_index: Optional[int] = None


class StartInterviewResponse(BaseModel):
    session_id: str
    opening_message: str
    speaker: Optional[str] = None  # for panel mode, which interviewer is opening


class RespondRequest(BaseModel):
    answer: str = Field(..., min_length=1, max_length=8000)


class RespondResponse(BaseModel):
    reply: str               # spoken text (code blocks stripped)
    should_finish: bool = False
    turn_number: int
    note: Optional[str] = None        # private interviewer observation for the notes panel
    speaker: Optional[str] = None     # panel-mode: which interviewer is speaking
    code_artifact: Optional[str] = None  # any code block the interviewer included


class Turn(BaseModel):
    role: Role
    content: str


class CriterionScore(BaseModel):
    name: str
    score: int = Field(..., ge=1, le=10)
    rationale: str


class QuestionSolution(BaseModel):
    question: str
    candidate_answer: Optional[str] = None
    model_answer: str
    feedback: Optional[str] = None


class EvaluationReport(BaseModel):
    candidate_name: Optional[str]
    topic: str
    difficulty: Difficulty
    overall_score: int = Field(..., ge=1, le=10)
    verdict: Literal["Strong Hire", "Hire", "Lean No Hire", "No Hire"]
    summary: str
    strengths: list[str]
    gaps: list[str]
    criteria: list[CriterionScore]
    question_solutions: list[QuestionSolution] = Field(default_factory=list)
    transcript: list[Turn]


class FinishResponse(BaseModel):
    report: EvaluationReport
