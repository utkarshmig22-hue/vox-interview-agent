# AI Voice Interviewer Agent — Roadmap

## Goal
Build an AI voice agent that conducts spoken interviews on **any topic**, holds a natural back-and-forth conversation with the candidate, and produces a structured evaluation at the end.

## Core Capabilities
1. **Topic-agnostic interviewing** — user picks a topic (e.g. "Python backend", "Machine Learning", "System Design", "Behavioral", "Marketing strategy") and difficulty.
2. **Voice in / voice out** — candidate speaks, agent speaks back.
3. **Adaptive questioning** — follow-ups based on the candidate's answers.
4. **Structured evaluation** — multi-criteria scoring with strengths, gaps, and an overall verdict.

## Tech Stack
| Layer | Choice | Rationale |
|---|---|---|
| LLM (brain) | Claude via Claude Agent SDK (runs on your Claude Max plan) | Strong reasoning, follows the interviewer persona, good evaluator |
| Backend | Python 3.10+ / FastAPI | Async, simple, easy to deploy |
| STT (speech → text) | Browser Web Speech API | Zero extra deps; works in Chrome/Edge/Safari |
| TTS (text → speech) | Browser Web Speech API | Same — keeps the demo dependency-free |
| Frontend | Vanilla HTML + CSS + JS | One page, no build step, instant to run |
| Session store | In-memory dict | Sufficient for single-user/demo; trivial to swap for Redis later |

## Architecture
```
┌──────────────────────┐         ┌─────────────────────────────────┐
│  Browser (frontend)  │         │       FastAPI backend           │
│                      │  HTTP   │                                 │
│  • Topic picker      │ ──────▶ │  POST /interview/start          │
│  • Mic (Web Speech)  │         │  POST /interview/{id}/respond   │
│  • Speaker (TTS)     │ ◀────── │  POST /interview/{id}/finish    │
│  • Transcript view   │         │                                 │
│  • Final report view │         │  ┌──────────────┐  ┌──────────┐ │
└──────────────────────┘         │  │ Interviewer  │  │Evaluator │ │
                                 │  │ (Claude)     │  │(Claude)  │ │
                                 │  └──────────────┘  └──────────┘ │
                                 └─────────────────────────────────┘
```

## Phases

### Phase 1 — Foundations (✅ complete)
- Pick stack, design API surface, lay out file structure.

### Phase 2 — Backend interview engine
- FastAPI app skeleton + CORS + static file mount.
- `Interviewer` class: builds the system prompt from topic + difficulty, drives the conversation, decides when to wrap up.
- `Session` store: keeps per-interview history.
- Endpoints:
  - `POST /api/interview/start` → returns `session_id` + opening question.
  - `POST /api/interview/{id}/respond` → candidate answer in, next interviewer turn out.
  - `POST /api/interview/{id}/finish` → triggers evaluation.

### Phase 3 — Evaluation engine
- `Evaluator` class: takes full transcript, asks Claude (with a strict JSON schema) to score the candidate on:
  - Technical accuracy
  - Depth of understanding
  - Communication clarity
  - Problem-solving approach
  - Confidence / composure
- Returns: per-criterion score (1–10), strengths, gaps, overall verdict (Strong Hire / Hire / Lean No / No Hire), summary.

### Phase 4 — Voice-enabled frontend
- Topic + difficulty + duration form.
- "Start interview" → backend call → speak the opening question via `SpeechSynthesis`.
- Mic button → `SpeechRecognition` → on result, POST to `/respond` → speak the reply.
- Live running transcript (interviewer + candidate turns).
- "Finish interview" → call `/finish` → render evaluation report card.

### Phase 5 — Docs & runnability
- `requirements.txt`, `.env.example`, `README.md`, `run.sh`.
- Setup steps (3 commands: install, set API key, run).

### Phase 6 — Verify
- Syntax check the Python.
- Spot-check the frontend wiring.
- Sanity-check the prompt design.

## Out of scope (v1)
- Multi-user auth.
- Persistence to disk / DB.
- Resume/CV parsing.
- Server-side STT/TTS (kept browser-side to avoid extra API keys).
- Video / face analysis.

## Extension ideas (post-v1)
- Swap Web Speech for ElevenLabs (TTS) + Whisper (STT) for higher quality.
- Persist past interviews and allow review.
- Resume upload → tailored questions.
- Code-pad alongside the call for coding interviews.
- Hiring-manager dashboard with aggregate stats.
