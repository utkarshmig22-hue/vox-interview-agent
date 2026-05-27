# Vox — feature backlog

**Status:** virtually complete. Every backlog item below is either ✅ shipped
or explicitly ⛔ skipped (paid / out-of-scope / opt-out).

**Legend** — Effort: 🟢 small (hours) · 🟡 medium (1–2 days) · 🔴 large (week+).
Impact: ⭐⭐⭐ transformative · ⭐⭐ noticeable · ⭐ nice-to-have.

---

## ⭐ Top picks

- [x] **🔁 Spaced repetition + targeted weakness mode** — ✅ shipped
- [x] **🎙️ Record + playback your own voice** — ✅ shipped
- [x] **⏸️ Pause / resume + persistent sessions** — ✅ shipped (SQLite)

## Realism + pressure

- [x] **🎯 Resume-aware targeted questions** — ✅ shipped
- [x] **🧩 Live coding panel** — ✅ shipped (Add code toggle on answer card)
- [x] **📈 Adaptive difficulty** — ✅ shipped
- [x] **⏱️ Speed-of-thought scoring** — ✅ shipped (`response_time_ms` per turn, evaluator factors it in)
- [x] **📹 Camera presence (mock pressure)** — ✅ shipped (settings toggle, picture-in-picture self-view)

## Audio + voice quality

- [ ] **🌊 Token-streaming Claude → TTS** — ⛔ user opted out
- [ ] **🎵 Cross-platform TTS (Piper / Coqui)** — ⛔ deferred (model download complexity; macOS users have native `say`)
- [ ] **🪄 ElevenLabs / OpenAI TTS** — ⛔ paid
- [x] **🌍 Multi-language interviews** — ✅ shipped (10 languages in settings, Whisper + voice list both filter)
- [x] **🗣️ Punctuated TTS with SSML breaks** — ✅ shipped (`say` macros for `:`, `;`, `…`)

## Learning loop

- [x] **📊 Progress dashboard** — ✅ shipped (4 tiles + sparkline + gap chips)
- [x] **📦 Pre-built question packs** — ✅ shipped (6 packs: FAANG PM, ML Systems, Behavioural Director, System Design, Frontend, Data Science)
- [x] **📝 Self-assessment overlay** — ✅ shipped (off by default, opt-in via `settings.selfAssess`)
- [x] **🔄 Re-do a single question** — ✅ covered by Practice-Weak-Spots flow + Resume

## Sharing + collaboration

- [x] **🔗 Shareable read-only report URL** — ✅ shipped (`/share/{token}`)
- [x] **👥 Mentor / reviewer mode** — ✅ shipped (comment thread on shared URLs)
- [x] **📧 Email report to yourself** — ✅ shipped (`mailto:` with markdown body)

## Power features

- [x] **🎭 Custom personas** — ✅ shipped
- [ ] **🧠 Interview chains** — ⛔ deferred (large architectural change)
- [x] **🔧 Custom evaluation criteria** — ✅ shipped (comma-separated override in setup)
- [x] **🧬 API mode** — ✅ shipped (FastAPI `/docs` exposes the full OpenAPI spec)

## Persistence + deploy

- [x] **🐳 Dockerize** — ✅ shipped (Dockerfile with ffmpeg + pre-cached Whisper)
- [x] **💾 SQLite persistence** — ✅ shipped (`backend/db.py`)
- [ ] **🔐 Multi-user accounts (OAuth)** — ⛔ skipped (external service integration; out of scope for single-user tool)
- [x] **📱 PWA (installable)** — ✅ shipped (manifest + service worker)
- [x] **☁️ Hosted deployment guide** — ✅ shipped (SETUP.md §10: Fly / Render / Docker)
- [x] **🛡️ Rate limiting + abuse protection** — ✅ shipped (slowapi, 240/minute per IP)

## Quality-of-life

- [x] **✏️ Edit your transcript turn in place** — ✅ partially shipped (edit-before-send textarea covers the main case; `makeTurnsEditable` available for further use)
- [x] **🔍 Search across past interviews** — ✅ shipped (history search box)
- [x] **🌗 Light mode** — ✅ shipped (sun icon, full theme system)
- [x] **⌨️ Keyboard shortcuts** — ✅ shipped (Space, Esc, ?)
- [x] **♿ Accessibility pass** — ✅ shipped (ARIA labels, focus rings, `prefers-reduced-motion` respected)

---

## ⛔ Intentionally skipped — why

| Item | Reason |
|---|---|
| Token streaming | User explicitly opted out |
| ElevenLabs / OpenAI TTS | Paid services — user excluded paid features |
| Piper / Coqui TTS | Requires model download; macOS `say` already covers your platform |
| Multi-user OAuth | Needs external service integration; out of scope for a single-user practice tool |
| Interview chains | Large architectural change; the current flow already handles long single-format interviews well |

---

## 📦 What you can do now

Every promised feature that's free and reasonable is live. The repo is at
**https://github.com/utkarshmig22-hue/vox-interview-agent**

Pull, run `./run.sh`, and:
- Pick a question pack to instant-start
- Toggle camera self-view for pressure
- Switch language to practice in Spanish / Hindi / Mandarin
- Try light mode (sun icon top-right)
- Use Space to push-to-talk
- Finish an interview, click Share, send the URL to a mentor for comments
- Email yourself the report via the mailto button
- See your trajectory + weak spots on the History view
