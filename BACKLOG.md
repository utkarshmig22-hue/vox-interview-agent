# Vox — feature backlog

Future work, ranked by impact/effort. Tick a box when shipped.

**Legend** — Effort: 🟢 small (hours) · 🟡 medium (1–2 days) · 🔴 large (week+).
Impact: ⭐⭐⭐ transformative · ⭐⭐ noticeable · ⭐ nice-to-have.

---

## ⭐ Top picks — "would do next"

- [ ] **🔁 Spaced repetition + targeted weakness mode** — 🟡 ⭐⭐⭐
  - Persist Gaps from each finished session
  - On setup screen, offer "Practice your weak spots from last week"
  - New mini-interview type that only quizzes recurring gap topics
  - **Why**: turns Vox from a practice tool into a training program

- [ ] **🎙️ Record + playback your own voice** — 🟡 ⭐⭐⭐
  - Stash the candidate's audio blob per turn (already captured for Whisper)
  - Tiny ▶ button next to each "You" turn in the transcript + report
  - Optional: filler-word counter ("um", "like", "basically")
  - **Why**: most actionable feedback you can get — hear yourself

- [ ] **⏸️ Pause / resume + persistent sessions** — 🟡 ⭐⭐⭐
  - Move session state to SQLite (or even localStorage)
  - "Resume" button in History
  - "In-progress" pill differentiating from completed
  - **Why**: don't lose work to a closed tab; enables real practice habit

---

## Realism + pressure

- [ ] **🎯 Resume-aware targeted questions** — 🟢 ⭐⭐
  - Use parsed resume fields aggressively in the prompt: *"I see you owned the driver-onboarding redesign at Delhivery — walk me through your A/B test design."*
  - Currently we extract but barely cite

- [ ] **🧩 Live coding panel** — 🟡 ⭐⭐
  - Editable code area for the candidate (currently only display)
  - Syntax highlighting (CodeMirror or Monaco)
  - Interviewer can see code and follow up: *"What's the time complexity?"* / *"What if input has duplicates?"*
  - Unlocks real technical interviews

- [ ] **📈 Adaptive difficulty** — 🟢 ⭐⭐
  - Track answer quality across turns
  - Ramp harder if crushing, ease up if struggling
  - System prompt mod + a simple running quality estimator

- [ ] **⏱️ Speed-of-thought scoring** — 🟢 ⭐
  - Track time-to-first-word and total response time per question
  - Factor into "Confidence & Composure" criterion
  - Show response-time stats in the report

- [ ] **📹 Camera presence (mock pressure)** — 🟢 ⭐
  - Optional self-view via `getUserMedia({video: true})`
  - Small picture-in-picture corner
  - Adds real interview tension; no recording, just live preview

---

## Audio + voice quality

- [ ] **🌊 Token-streaming Claude → TTS** — 🔴 ⭐⭐⭐
  - Bypass Claude Agent SDK; call `claude --output-format stream-json` directly
  - Pipe tokens out via SSE
  - Frontend accumulates → sentence boundary → fire TTS
  - Drops post-answer dead-air from ~5s → ~1s
  - **The single biggest realism lever left**

- [ ] **🎵 Cross-platform TTS (Piper / Coqui)** — 🟡 ⭐⭐
  - Pure-Python neural TTS, runs on CPU
  - Linux/Windows currently fall back to robotic browser voice
  - Models ~50–100MB; quality close to commercial

- [ ] **🪄 ElevenLabs / OpenAI TTS integration** — 🟢 ⭐⭐
  - Add optional cloud TTS as `TTS_BACKEND=elevenlabs`
  - Near-perfect human voice
  - Costs ~$5–10/month with light use
  - Could be opt-in for users with API keys

- [ ] **🌍 Multi-language interviews** — 🟢 ⭐⭐
  - Whisper supports 99 languages; `say` supports ~70
  - Language picker in setup; pass to STT/TTS/prompts
  - Practice in Hindi / Spanish / Mandarin

- [ ] **🗣️ Punctuated TTS with SSML breaks** — 🟢 ⭐
  - Use `say` macros for explicit pauses on emphasis words
  - Better intonation on questions vs statements (we have rate variation, this would add prosody)

---

## Learning loop

- [ ] **📊 Progress dashboard** — 🟡 ⭐⭐
  - Replace flat History list with trend charts
  - Scores per criterion over time
  - Recurring gap topics (word cloud or frequency list)
  - Time-of-day patterns (do you perform better in the morning?)

- [ ] **📦 Pre-built question packs** — 🟢 ⭐⭐
  - "FAANG PM 2025", "ML Systems Senior IC", "Behavioural — director-level"
  - One click → full setup populated → start
  - Could ship a few hand-curated; later let users share their own

- [ ] **📝 Self-assessment overlay** — 🟢 ⭐
  - After each Q, briefly let the user rate their own answer (1-5)
  - Compare candidate self-rating vs interviewer score in the report
  - Calibration insight — *"you rate yourself higher than the interviewer does on technical questions"*

- [ ] **🔄 Re-do a single question** — 🟢 ⭐
  - In the report, click any Q and "Try again" — runs a one-question mini-session
  - Compare your two answers side-by-side

---

## Sharing + collaboration

- [ ] **🔗 Shareable read-only report URL** — 🟡 ⭐⭐
  - Generate a stable share token, save report server-side
  - Public URL renders the report (no setup form, no controls)
  - DM to a mentor for human feedback

- [ ] **👥 Mentor / reviewer mode** — 🔴 ⭐⭐
  - Mentor opens the shared URL
  - Can leave inline comments on specific turns
  - Comments appear next to the report when candidate re-opens

- [ ] **📧 Email report to yourself** — 🟢 ⭐
  - Quick action on report screen
  - Uses local mail client (mailto:) or backend SMTP

---

## Power features

- [ ] **🎭 Custom personas** — 🟢 ⭐⭐
  - Let users define their own (name, system-prompt snippet, preferred voice)
  - Save in localStorage alongside templates
  - Mock the specific interviewer you've researched

- [ ] **🧠 Interview chains** — 🟡 ⭐⭐
  - String multiple interviews together (technical → behavioural → wrap-up)
  - Single overarching evaluation
  - Models a real onsite loop

- [ ] **🔧 Custom evaluation criteria** — 🟢 ⭐
  - Replace the fixed 5 criteria with user-defined ones for niche roles
  - "Storytelling craft" / "Calligraphy precision" / whatever

- [ ] **🧬 API mode** — 🟡 ⭐
  - Document the existing endpoints as a public API
  - Auth tokens for programmatic use
  - Enables other apps to embed Vox interviews

---

## Persistence + deploy

- [ ] **🐳 Dockerize** — 🟢 ⭐⭐
  - Single container with the venv + Whisper model baked in
  - `docker run -p 8000:8000 -v ~/.claude:/root/.claude vox` and you're up
  - Enables easy self-hosting

- [ ] **💾 SQLite persistence** — 🟡 ⭐⭐
  - Replace in-memory session store
  - Sessions, history, templates all in `vox.db`
  - Foundation for multi-user / multi-device

- [ ] **🔐 Multi-user accounts** — 🔴 ⭐⭐
  - Google/GitHub OAuth
  - Per-user history, templates, settings
  - Hosted deployment becomes viable

- [ ] **📱 PWA (installable)** — 🟢 ⭐
  - Manifest + service worker
  - Install to dock/home-screen; feels native
  - Works offline for the UI (Claude calls still need network)

- [ ] **☁️ Hosted deployment guide** — 🟢 ⭐
  - Fly.io / Railway / Render walkthroughs in SETUP.md
  - Public URL for the app

- [ ] **🛡️ Rate limiting + abuse protection** — 🟢 ⭐
  - Once it's public: per-IP rate limits, captcha on resume upload
  - Background already adds `python-multipart`; throttling needs slowapi

---

## Quality-of-life

- [ ] **✏️ Edit your transcript turn in place** — 🟢 ⭐
  - "I meant to say X, not Y" — fix and re-submit
  - Re-runs from that turn forward

- [ ] **🔍 Search across past interviews** — 🟢 ⭐
  - Find every interview where you discussed "rate limiting"
  - localStorage scan + simple keyword index

- [ ] **🌗 Light mode** — 🟢 ⭐
  - Currently dark-only; toggle in settings
  - Use `prefers-color-scheme` for auto

- [ ] **⌨️ Keyboard shortcuts** — 🟢 ⭐
  - Space = hold-to-talk
  - Enter = send answer
  - Esc = interrupt interviewer
  - `?` = show keymap

- [ ] **♿ Accessibility pass** — 🟡 ⭐
  - ARIA labels everywhere
  - Keyboard navigation through report
  - Screen reader support for transcript

---

## Done (for reference)

These are already shipped as of commit `9f6f77e`:

- [x] Job interview mode
- [x] Study mode with PDF/DOCX upload
- [x] Whisper-based STT (local, faster-whisper, punctuation preserved)
- [x] macOS `say` TTS with pronunciation map
- [x] Animated SVG avatar with audio-reactive lip-sync, blinks, persona moods
- [x] 4 personas including 2-voice panel interview
- [x] Resume upload → auto-fill setup
- [x] Templates (save/load/delete setup configs)
- [x] Practice history (localStorage)
- [x] Live notes panel + code artifact panel
- [x] Time budget + clock
- [x] Smart VAD (0.8s end-of-speech)
- [x] Instant acknowledgements pre-cached
- [x] Interrupt-on-mic during TTS
- [x] Voice tone variation per sentence
- [x] Per-question model answers in evaluation
- [x] Word .docx + Markdown report download
- [x] Settings panel (voice picker, speed, auto-flow)
- [x] Sonnet 4.6 for turns, Opus 4.7 for evaluation (~38% Max-plan quota savings)
- [x] Perf: cached `say` voice list, throttled ack warmup
- [x] Async I/O wrapping (no more event-loop blocking)
- [x] Claude turn timeouts (90s) so hangs don't freeze UI forever

---

## How to use this backlog

When you're ready to ship the next feature:
1. Pick a checkbox from the **Top picks** or another section
2. Reply with the line (e.g. *"do the spaced repetition one"*) and I'll build it
3. We'll tick the box and push together

Good defaults if you want me to pick:
- **Habit-forming:** ship the top 3 picks together
- **Pure quality:** token streaming + cross-platform TTS
- **Most-requested-likely-by-users:** coding panel + pause/resume
