# Vox — AI Voice Interviewer

A voice-driven AI agent that runs spoken interviews — or quizzes you on your own study material — and gives you a structured scored report at the end.

You speak; it listens (via Whisper). It speaks back (via the macOS native voice engine, with an animated avatar lip-syncing to the audio). At the end, you get a multi-criteria evaluation with model answers per question.

---

## Quick start

**On a fresh machine** (you'll need [Claude Code](https://docs.claude.com/en/docs/claude-code/quickstart) installed and signed in):

```bash
bash setup.sh
./run.sh
```

Open **http://127.0.0.1:8000**.

> Full prerequisites, transfer instructions, troubleshooting, and tunables are in **[SETUP.md](./SETUP.md)**.

---

## Two modes

### 1. Job interview
Practice for a real interview. Pick:
- Topic (e.g. "Python backend", "Senior PM at fintech", "Behavioural — leadership")
- Difficulty (beginner → expert)
- Persona — Friendly Mentor / Hiring Manager / Skeptical Senior / Panel (2 voices)
- Interview style — conversational / behavioural / case study / tech deep-dive / mixed
- Time budget + question count
- Optional: paste your background, focus areas, scenarios, or **upload your resume to auto-fill** all of it

### 2. Study mode
Quiz yourself on what you've learned. Upload (or paste) a PDF, DOCX, lecture notes, or any text. The coach asks Socratic questions grounded in that material, probes your gaps, and at the end tells you which concepts you actually own and which need review.

---

## What you get

- **Voice in (Whisper)** — local STT via `faster-whisper`. Handles punctuation, tech terms (API, JSON, P99, OAuth, Kubernetes), and proper capitalisation. ~1.5s latency.
- **Voice out (macOS `say`)** — uses your system voices with pronunciation map for acronyms. Install Premium voices for near-human quality.
- **Animated SVG avatar** — face with lip-sync (mouth opens with real audio amplitude), idle blinks, persona-specific moods (friendly / skeptical / etc.), speaker chip in panel mode.
- **Real-time UX** — smart VAD (auto-stop on 0.8s silence), instant acknowledgements ("Got it, let me think…"), interrupt-on-mic.
- **Live notes panel** — see what the interviewer is privately tracking about your answers, in real time.
- **Code artifact panel** — interviewer can share snippets without speaking them aloud.
- **Time budget + clock** — interviewer wraps up as time runs out.
- **Scored report** — overall + per-criterion (Technical, Depth, Communication, Problem-Solving, Confidence), verdict, strengths, gaps, and **model answers per question** to study from.
- **Practice history** — every finished session saved locally for review and trajectory tracking.
- **Templates** — save your interview setup (e.g. "Senior PM — Fintech") and reload in one click.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          Browser                              │
│ ┌────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────────┐ │
│ │ Avatar │  │  Mic     │  │  Notes /    │  │  Settings    │ │
│ │ (SVG + │  │  (Media  │  │  Code /     │  │  (voice,     │ │
│ │ lip-   │  │  Recorder│  │  Clock /    │  │  speed,      │ │
│ │ sync)  │  │  + VAD)  │  │  Transcript │  │  flow)       │ │
│ └────────┘  └──────────┘  └─────────────┘  └──────────────┘ │
└──────────────────────────────────────────────────────────────┘
                            │
                  HTTP (multipart + JSON)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                       FastAPI (Python)                        │
│                                                               │
│  /api/interview/start        ──▶  interviewer.py             │
│  /api/interview/{id}/respond ──▶  ┌──────────────────┐       │
│  /api/interview/{id}/finish  ──▶  │ Claude Sonnet    │       │
│                                   │ via Agent SDK    │       │
│                                   │ (Max plan OAuth) │       │
│                                   └──────────────────┘       │
│  /api/transcribe       ──▶  stt.py     → faster-whisper       │
│  /api/tts              ──▶  tts.py     → macOS `say`          │
│  /api/voices           ──▶  tts.py     → installed voices     │
│  /api/resume/parse     ──▶  resume.py  → pypdf + Claude       │
│  /api/material/extract ──▶  resume.py  → text extraction      │
│  /api/health           ──▶  status                            │
└──────────────────────────────────────────────────────────────┘
```

- **LLM**: Claude Agent SDK on your Max plan (Sonnet 4.6 for turns, Opus 4.7 for evaluation; both configurable)
- **STT**: faster-whisper, runs locally (default `small.en`)
- **TTS**: macOS `say` with pronunciation map for tech terms (falls back to browser Web Speech if not on macOS)
- **State**: in-memory sessions; history persisted to browser `localStorage`

See **[ROADMAP.md](./ROADMAP.md)** for the original design.

---

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET  | `/api/health` | Status — auth mode, model versions, STT/TTS availability |
| GET  | `/api/voices` | List installed macOS voices |
| POST | `/api/tts` | Synthesise WAV from text (whole-utterance) |
| POST | `/api/transcribe` | Whisper transcribe an audio blob → text |
| POST | `/api/resume/parse` | PDF/DOCX → structured candidate profile (Claude) |
| POST | `/api/material/extract` | PDF/DOCX → plain text + word count |
| POST | `/api/interview/start` | Begin a session, get opening message |
| POST | `/api/interview/{id}/respond` | Submit an answer, get next interviewer turn |
| POST | `/api/interview/{id}/finish` | End the session, get the evaluation report |

Swagger UI: http://127.0.0.1:8000/docs

---

## Configuration

All optional; tweak in `.env` or your shell.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_INTERVIEWER_MODEL` | `claude-sonnet-4-6` | Live interviewer turns (snappy, ~5× less quota than Opus) |
| `CLAUDE_EVALUATOR_MODEL` | `claude-opus-4-7` | Post-interview scored report (deeper reasoning) |
| `CLAUDE_RESUME_MODEL` | `claude-sonnet-4-6` | Resume profile extraction |
| `CLAUDE_MODEL` | unset | Override for both interviewer and evaluator |
| `WHISPER_MODEL` | `small.en` | `tiny.en` / `base.en` / `small.en` / `medium.en` / `large-v3` |
| `WHISPER_DEVICE` | `auto` | `cpu` / `cuda` / `metal` |
| `WHISPER_COMPUTE` | `int8` | `float16` for GPU |
| `ANTHROPIC_API_KEY` | unset | If set, bills the API instead of your Max plan |
| `HOST`, `PORT` | `127.0.0.1`, `8000` | Server bind |

---

## Project layout

```
Interview_voice_agent/
├── README.md          ← you are here
├── SETUP.md           ← full install / troubleshooting
├── ROADMAP.md         ← original design
├── setup.sh           ← one-shot installer
├── run.sh             ← start the server
├── requirements.txt
├── .env.example
├── backend/
│   ├── main.py        ← FastAPI app + all endpoints
│   ├── interviewer.py ← Claude-driven interviewer (job + study modes)
│   ├── evaluator.py   ← structured scoring + model answers
│   ├── tts.py         ← macOS say wrapper + pronunciation map
│   ├── stt.py         ← faster-whisper wrapper
│   ├── resume.py      ← PDF/DOCX extraction + Claude profile parse
│   ├── models.py / session.py
├── frontend/
│   ├── index.html     ← single-page UI (no build step)
│   ├── style.css      ← dark glassmorphism + avatar
│   └── app.js         ← Whisper recorder, TTS pipeline, avatar lip-sync, modes, history
└── scripts/
    └── timing_test.py
```

---

## Troubleshooting

See **[SETUP.md §7](./SETUP.md#7-common-gotchas)** for the full list. Most common:

- `/api/health` shows `auth: "api_key"` → `unset ANTHROPIC_API_KEY` and restart
- First mic recording takes ~60s to transcribe → Whisper warming up, subsequent calls are 1–2s
- Voice picker only shows generic voices → install Premium voices (System Settings → Accessibility → Spoken Content → Customize)
- Mic permission denied → browser blocked the mic; allow it in the address-bar permissions

---

## License

MIT — do whatever you want with it.
