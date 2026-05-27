import asyncio
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
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
    FinishResponse,
    RespondRequest,
    RespondResponse,
    StartInterviewRequest,
    StartInterviewResponse,
)
from .session import store  # noqa: E402

app = FastAPI(title="Vox · AI Voice Interviewer", version="1.1.0")

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
async def transcribe(file: UploadFile = File(...)) -> dict:
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
            stt.transcribe, content, file.content_type or "audio/webm"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    return {"text": text}


# --- TTS endpoints -----------------------------------------------------------
@app.get("/api/voices")
def get_voices() -> dict:
    """List installed English voices on the host (macOS `say`)."""
    available = tts.is_available()
    return {
        "voices": tts.list_voices() if available else [],
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
async def respond(session_id: str, req: RespondRequest) -> RespondResponse:
    session = store.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.finished:
        raise HTTPException(status_code=400, detail="Interview already finished")
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
