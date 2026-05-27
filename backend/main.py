import asyncio
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

# IMPORTANT: the Claude Agent SDK falls back to ANTHROPIC_API_KEY when set,
# which would bypass the Max-plan OAuth and bill the API account instead.
# Strip any placeholder / leftover key BEFORE importing the SDK-using modules.
_key = os.environ.get("ANTHROPIC_API_KEY", "")
if not _key or _key.startswith("sk-ant-xxxxxxxx"):
    os.environ.pop("ANTHROPIC_API_KEY", None)

from . import db, evaluator, interviewer, report_export, resume, stt, tts  # noqa: E402
from .models import (  # noqa: E402
    CommentRequest,
    FinishResponse,
    RespondRequest,
    RespondRequestExt,
    RespondResponse,
    StartInterviewRequest,
    StartInterviewResponse,
)
from .session import store  # noqa: E402

app = FastAPI(title="Vox · AI Voice Interviewer", version="1.2.0")

# Rate limiting — guards expensive endpoints (LLM calls, file uploads) from
# accidental abuse. Per-IP. Off if SLOWAPI is not installed.
try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    limiter = Limiter(key_func=get_remote_address, default_limits=["240/minute"])
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
except ImportError:
    limiter = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _check_env() -> None:
    if os.environ.get("ANTHROPIC_API_KEY"):
        print("[info] ANTHROPIC_API_KEY detected — Agent SDK will use it instead of Claude Max OAuth.")
    else:
        print("[info] No ANTHROPIC_API_KEY set — using Claude Code OAuth (Max plan).")
    model = os.environ.get("CLAUDE_MODEL")
    if model:
        print(f"[info] Model override: {model}")
    # Pre-warm Whisper in the background so the first transcribe is fast.
    if stt.is_available():
        print(f"[info] Whisper STT available (model={stt.info()['model']}). Warming in background…")
        stt.warm()


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "auth": "api_key" if os.environ.get("ANTHROPIC_API_KEY") else "claude_code_oauth",
        "interviewer_model": interviewer._model(),
        "evaluator_model": evaluator._model(),
        "tts_backend": "macos_say" if tts.is_available() else None,
        "stt_backend": "whisper" if stt.is_available() else None,
        "stt": stt.info(),
    }


# --- Study material text extraction ----------------------------------------
@app.post("/api/material/extract")
async def extract_material(file: UploadFile = File(...)) -> dict:
    """Extract plain text from a PDF/DOCX/TXT study upload — no LLM call.
    Returns text + word count + page-ish stats so the user can see what loaded."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > resume.MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (>{resume.MAX_BYTES // (1024*1024)} MB)",
        )
    try:
        # Sync I/O (pypdf / python-docx) → run in a thread so we don't block
        # the FastAPI event loop. Otherwise EVERY other request queues behind it.
        text = await asyncio.to_thread(
            resume.extract_text, file.filename or "material", content
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read file: {e}")
    word_count = len(text.split())
    # Cap to 80k chars (matches StartInterviewRequest.study_material limit).
    truncated = False
    if len(text) > 80000:
        text = text[:80000]
        truncated = True
    return {
        "text": text,
        "word_count": word_count,
        "char_count": len(text),
        "truncated": truncated,
        "filename": file.filename,
    }


# --- Report export (Word .docx) --------------------------------------------
class ReportExportRequest(BaseModel):
    report: dict
    format: str = Field("full", pattern="^(full|qa)$",
                        description="'full' (everything) or 'qa' (Q&A study sheet)")


@app.post("/api/report/export")
async def export_report(req: ReportExportRequest) -> Response:
    """Generate a Word .docx of the interview report. Returns the binary file."""
    try:
        if req.format == "qa":
            data = await asyncio.to_thread(report_export.build_qa_docx, req.report)
            stem = "vox-qa"
        else:
            data = await asyncio.to_thread(report_export.build_full_docx, req.report)
            stem = "vox-report"
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not build report: {e}")

    topic = (req.report.get("topic") or "interview").lower()
    safe_topic = "".join(c if c.isalnum() else "-" for c in topic).strip("-")[:60] or "interview"
    filename = f"{stem}-{safe_topic}.docx"

    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Resume parsing ---------------------------------------------------------
@app.post("/api/resume/parse")
async def parse_resume(file: UploadFile = File(...)) -> dict:
    """Accept a PDF/DOCX/TXT resume, return a structured profile dict that the
    frontend can drop into the setup form (name, background, role context, etc.)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > resume.MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (>{resume.MAX_BYTES // (1024*1024)} MB)",
        )
    try:
        text = await asyncio.to_thread(
            resume.extract_text, file.filename or "resume", content
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read resume: {e}")
    try:
        profile = await resume.parse_to_profile(text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not parse resume: {e}")
    return profile


# --- STT endpoint -----------------------------------------------------------
@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = "en") -> dict:
    """Transcribe an uploaded audio blob (webm/ogg/wav/m4a) via Whisper."""
    if not stt.is_available():
        raise HTTPException(status_code=501, detail="Whisper STT not installed on server")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty audio")
    try:
        # Whisper inference is the single heaviest sync call on the server.
        # Without to_thread, a 5-second transcribe call blocks every other
        # request for 1-2 seconds — that's the "mid-session hang" the user saw.
        text = await asyncio.to_thread(
            stt.transcribe, content, file.content_type or "audio/webm", language
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    return {"text": text}


# --- TTS endpoints -----------------------------------------------------------
@app.get("/api/voices")
def get_voices(lang: str = "en_") -> dict:
    """List installed voices on the host (macOS `say`). `lang` filters by
    language prefix (e.g. 'en_', 'es_', 'fr_'). Use '' for all."""
    available = tts.is_available()
    return {
        "voices": tts.list_voices(language_prefix=lang) if available else [],
        "available": available,
    }


class TTSRequest(BaseModel):
    text: str = Field(..., max_length=8000)
    voice: Optional[str] = None
    rate: int = Field(175, ge=80, le=320, description="Words per minute, default ~175")


@app.post("/api/tts")
async def synthesize_speech(req: TTSRequest) -> Response:
    if not tts.is_available():
        raise HTTPException(status_code=501, detail="Backend TTS unavailable on this host")
    try:
        # `say` is a subprocess that takes ~700ms — also wrapped in to_thread
        # so concurrent /api/tts calls don't serialize through the event loop.
        audio = await asyncio.to_thread(
            tts.synthesize, req.text, req.voice, req.rate
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")
    if not audio:
        raise HTTPException(status_code=400, detail="Empty text")
    return Response(content=audio, media_type="audio/wav")


@app.post("/api/interview/start", response_model=StartInterviewResponse)
async def start_interview(req: StartInterviewRequest) -> StartInterviewResponse:
    session = store.create(
        topic=req.topic,
        difficulty=req.difficulty,
        target_questions=req.target_questions,
        candidate_name=req.candidate_name,
        role_context=req.role_context,
        focus_areas=req.focus_areas,
        candidate_background=req.candidate_background,
        scenarios_to_cover=req.scenarios_to_cover,
        interview_style=req.interview_style,
        persona=req.persona,
        small_talk=req.small_talk,
        target_minutes=req.target_minutes,
        mode=req.mode,
        study_material=req.study_material,
        custom_persona_name=req.custom_persona_name,
        custom_persona_prompt=req.custom_persona_prompt,
        adaptive_difficulty=req.adaptive_difficulty,
        custom_criteria=req.custom_criteria,
        resume_centric=req.resume_centric,
    )
    try:
        parsed = await interviewer.open_interview(session)
    except Exception as e:
        store.drop(session.id)
        raise HTTPException(status_code=500, detail=f"Failed to start interview: {e}")
    return StartInterviewResponse(
        session_id=session.id,
        opening_message=parsed["say"],
        speaker=parsed.get("speaker"),
    )


@app.post("/api/interview/{session_id}/respond", response_model=RespondResponse)
async def respond(session_id: str, req: RespondRequestExt) -> RespondResponse:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.finished:
        raise HTTPException(status_code=400, detail="Interview already finished")
    # Speed-of-thought: record how long the candidate took (frontend reports it).
    if req.response_time_ms is not None:
        session.turn_response_ms.append(req.response_time_ms)
    try:
        parsed = await interviewer.next_turn(session, req.answer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Interviewer failed: {e}")
    return RespondResponse(
        reply=parsed["say"],
        should_finish=parsed["done"],
        turn_number=session.primary_questions_asked,
        note=parsed.get("note"),
        speaker=parsed.get("speaker"),
        code_artifact=parsed.get("code"),
    )


# --- Sessions list / resume / audio playback / spaced repetition ----------
@app.get("/api/sessions")
def list_sessions(status: str = "all") -> dict:
    """`status`: 'all' | 'finished' | 'in_progress'. Returns sessions newest first."""
    only = None
    if status == "finished": only = True
    if status == "in_progress": only = False
    return {"sessions": db.list_sessions(only_finished=only, limit=100)}


@app.get("/api/interview/{session_id}/resume")
def resume_session(session_id: str) -> dict:
    """Hydrate an interview so the frontend can pick up where it left off
    (after a reload, after a different device — anywhere SQLite is reachable)."""
    session = store.get(session_id)
    if session is None:
        raise HTTPException(404, "Session not found")
    return {
        "id": session.id,
        "topic": session.topic,
        "difficulty": session.difficulty,
        "candidate_name": session.candidate_name,
        "target_questions": session.target_questions,
        "target_minutes": session.target_minutes,
        "persona": session.persona,
        "interview_style": session.interview_style,
        "mode": session.mode,
        "finished": session.finished,
        "primary_questions_asked": session.primary_questions_asked,
        "turns": [{"role": t.role, "content": t.content} for t in session.turns],
        "notes": list(session.notes),
        "last_speaker": session.last_speaker,
        "report": session._report,
    }


@app.post("/api/interview/{session_id}/audio/{turn_index}")
async def save_turn_audio(session_id: str, turn_index: int, file: UploadFile = File(...)) -> dict:
    """Store the candidate's audio for a turn so we can play it back in the report."""
    if not store.get(session_id):
        raise HTTPException(404, "Session not found")
    content = await file.read()
    if not content:
        raise HTTPException(400, "Empty audio")
    await asyncio.to_thread(
        db.save_audio, session_id, turn_index, content, file.content_type or "audio/webm"
    )
    return {"ok": True}


@app.get("/api/interview/{session_id}/audio/{turn_index}")
def get_turn_audio(session_id: str, turn_index: int) -> Response:
    result = db.get_audio(session_id, turn_index)
    if not result:
        raise HTTPException(404, "Audio not found")
    audio, mime = result
    return Response(content=audio, media_type=mime)


# --- Shareable read-only reports + mentor comments -----------------------
@app.post("/api/interview/{session_id}/share")
def create_share(session_id: str) -> dict:
    """Mint a public read-only token for an interview report."""
    if not store.get(session_id):
        raise HTTPException(404, "Session not found")
    token = db.create_share(session_id)
    return {"token": token, "url": f"/share/{token}"}


@app.get("/api/share/{token}")
def get_share(token: str) -> dict:
    """Return the report + transcript + comments for a shared session."""
    session_id = db.get_share(token)
    if not session_id:
        raise HTTPException(404, "Share not found")
    session = store.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "report": session._report,
        "topic": session.topic,
        "transcript": [{"role": t.role, "content": t.content} for t in session.turns],
        "comments": db.list_comments(token),
    }


@app.post("/api/share/{token}/comments")
def post_comment(token: str, req: CommentRequest) -> dict:
    if not db.get_share(token):
        raise HTTPException(404, "Share not found")
    return db.add_comment(token, req.body, author=req.author, turn_index=req.turn_index)


@app.get("/api/share/{token}/comments")
def get_comments(token: str) -> dict:
    if not db.get_share(token):
        raise HTTPException(404, "Share not found")
    return {"comments": db.list_comments(token)}


# --- Question packs (preset interview templates) -------------------------
_QUESTION_PACKS = [
    {
        "id": "faang-pm",
        "name": "FAANG PM — Senior",
        "topic": "Senior Product Management — consumer tech",
        "difficulty": "advanced",
        "target_questions": 7,
        "target_minutes": 25,
        "interview_style": "case-study",
        "persona": "hiring-manager",
        "focus_areas": "product sense, metric design, user research, prioritisation under ambiguity, "
                       "cross-functional leadership, technical fluency",
    },
    {
        "id": "ml-systems",
        "name": "ML Systems — Senior IC",
        "topic": "ML systems and infrastructure",
        "difficulty": "advanced",
        "target_questions": 6,
        "target_minutes": 30,
        "interview_style": "technical-deep-dive",
        "persona": "skeptical-senior",
        "focus_areas": "model training pipelines, feature stores, inference latency, model drift, "
                       "AB testing, MLOps and reproducibility",
    },
    {
        "id": "behavioural-director",
        "name": "Behavioural — Director level",
        "topic": "Engineering leadership — director track",
        "difficulty": "advanced",
        "target_questions": 6,
        "target_minutes": 30,
        "interview_style": "structured-behavioral",
        "persona": "panel",
        "focus_areas": "scaling teams, managing managers, navigating reorgs, performance management, "
                       "stakeholder alignment, strategic narrative",
    },
    {
        "id": "system-design",
        "name": "System design — Senior backend",
        "topic": "Distributed system design",
        "difficulty": "advanced",
        "target_questions": 5,
        "target_minutes": 35,
        "interview_style": "case-study",
        "persona": "skeptical-senior",
        "focus_areas": "scalability, consistency vs availability, caching, queueing, observability, "
                       "failure modes, capacity estimation",
    },
    {
        "id": "frontend-engineer",
        "name": "Frontend engineer — mid/senior",
        "topic": "Frontend engineering — React / TypeScript",
        "difficulty": "intermediate",
        "target_questions": 6,
        "target_minutes": 25,
        "interview_style": "mixed",
        "persona": "hiring-manager",
        "focus_areas": "component architecture, state management, performance, accessibility, "
                       "testing, type safety",
    },
    {
        "id": "data-scientist",
        "name": "Data scientist — applied",
        "topic": "Applied data science and statistics",
        "difficulty": "intermediate",
        "target_questions": 6,
        "target_minutes": 25,
        "interview_style": "mixed",
        "persona": "friendly-mentor",
        "focus_areas": "experimental design, statistical inference, regression diagnostics, "
                       "feature engineering, communicating results to non-technical stakeholders",
    },
]


@app.get("/api/question-packs")
def question_packs() -> dict:
    return {"packs": _QUESTION_PACKS}


@app.get("/api/weak-spots")
def weak_spots() -> dict:
    """Aggregated gaps from recent finished interviews — drives the
    'Practice your weak spots' button on the setup screen."""
    raw = db.aggregate_gaps(limit_sessions=20)
    # Count + collapse near-duplicates by simple lower-case normalisation
    counts: dict[str, dict] = {}
    for item in raw:
        key = item["gap"].strip().lower()[:120]
        if key not in counts:
            counts[key] = {"gap": item["gap"], "count": 0, "latest_topic": item["topic"], "latest_date": item["date"]}
        counts[key]["count"] += 1
        if item["date"] > counts[key]["latest_date"]:
            counts[key]["latest_topic"] = item["topic"]
            counts[key]["latest_date"] = item["date"]
    return {"gaps": sorted(counts.values(), key=lambda g: (-g["count"], -g["latest_date"]))[:25]}


@app.post("/api/interview/{session_id}/finish", response_model=FinishResponse)
async def finish(session_id: str) -> FinishResponse:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.turns:
        raise HTTPException(status_code=400, detail="No transcript to evaluate")
    try:
        report = await evaluator.evaluate(
            topic=session.topic,
            difficulty=session.difficulty,
            candidate_name=session.candidate_name,
            turns=session.turns,
            role_context=session.role_context,
            focus_areas=session.focus_areas,
            mode=session.mode,
            study_material=session.study_material,
            custom_criteria=session.custom_criteria,
            response_times_ms=list(session.turn_response_ms) or None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Evaluation failed: {e}")
    session.finished = True
    # Cache report so weak-spots and resume can re-render it without recomputing.
    session._report = report.model_dump() if hasattr(report, "model_dump") else dict(report)
    store.save(session)
    return FinishResponse(report=report)


# --- Static frontend ---------------------------------------------------------
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(str(FRONTEND_DIR / "index.html"))

    @app.get("/share/{token}")
    def share_index(token: str) -> FileResponse:
        """Serve the same SPA — frontend detects /share/ in the URL and
        opens the read-only mentor view."""
        return FileResponse(str(FRONTEND_DIR / "index.html"))
