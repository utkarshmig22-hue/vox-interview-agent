# Vox — full setup guide (new machine)

This walks through getting Vox running on a fresh machine that already has the **Claude Code CLI** installed.

> **TL;DR**: `bash setup.sh && ./run.sh` (after transferring the project + logging in to Claude Code).

---

## 0. Prerequisites

| Need | Why | Check |
|---|---|---|
| **macOS** (recommended) | Backend TTS uses macOS `say`; the Premium voices are *much* better than browser ones | `uname` |
| **Python 3.10+** | Backend runtime | `python3 --version` |
| **Claude Code CLI**, signed in | LLM auth — uses your Claude Max plan | `claude --version` then `claude login` if needed |
| **Modern browser** | Chrome / Edge / Safari (for mic + audio) | open `chrome://settings/content/microphone` etc. |
| **~3 GB free disk** | Whisper model + Python deps | `df -h` |

> Vox also runs on Linux/Windows, but you'll fall back to browser-engine TTS for the interviewer voice (lower quality). Whisper STT still works everywhere.

---

## 1. Transfer the project

Pick whichever you prefer.

### Option A — via git
On the **old** machine:
```bash
cd /path/to/Interview_voice_agent
git init && git add -A && git commit -m "snapshot"
# push to GitHub/GitLab/private remote, then on the new machine:
git clone <remote-url> Interview_voice_agent
```

### Option B — via tarball / scp / AirDrop
On the old machine:
```bash
cd /path/to/Interview_voice_agent/..
# Exclude the venv and downloaded model cache so the tarball stays small (~few MB)
tar --exclude='.venv' --exclude='__pycache__' --exclude='node_modules' \
    -czf vox.tar.gz Interview_voice_agent/
# scp / AirDrop / USB the file to the new machine
```

On the new machine:
```bash
tar -xzf vox.tar.gz
cd Interview_voice_agent
```

---

## 2. One-command setup (recommended)

```bash
bash setup.sh
```

This checks prerequisites, creates `.venv/`, installs dependencies, copies `.env.example` → `.env`, and pre-warms the Whisper model.

First run downloads roughly **500 MB** of Whisper model weights and **~200 MB** of Python dependencies — give it 2–5 minutes on a decent connection.

If the script succeeds you can skip straight to **§4 Launch**.

---

## 3. Manual setup (if the script doesn't work)

```bash
# 3.1 Virtualenv
python3 -m venv .venv
source .venv/bin/activate

# 3.2 Dependencies
pip install --upgrade pip
pip install -r requirements.txt

# 3.3 .env (no API key needed — uses Max plan)
cp .env.example .env

# 3.4 (Optional) pre-warm Whisper so the first transcribe call is fast
python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='auto', compute_type='int8')"
```

---

## 4. Launch

```bash
./run.sh
```

That:
- `unset`s `ANTHROPIC_API_KEY` (so the Agent SDK uses your Max plan via Claude Code OAuth)
- Activates the virtualenv
- Boots uvicorn on `http://127.0.0.1:8000` with auto-reload

Open **http://127.0.0.1:8000** in your browser. First mic-button click will prompt for permission — grant it.

---

## 5. Verify everything works

In a second terminal:

```bash
curl -s http://127.0.0.1:8000/api/health | python3 -m json.tool
```

You should see:
```json
{
  "ok": true,
  "auth": "claude_code_oauth",
  "interviewer_model": "claude-sonnet-4-6",
  "evaluator_model": "claude-opus-4-7",
  "tts_backend": "macos_say",
  "stt_backend": "whisper",
  "stt": { "available": true, "model": "small.en", "loaded": true }
}
```

Key things to confirm:
- `"auth": "claude_code_oauth"` — using your **Max plan**, not API credits
- `"tts_backend": "macos_say"` — high-quality voice (macOS only)
- `"stt_backend": "whisper"` — Whisper installed and ready
- `"loaded": true` — model already warmed (first transcribe is fast)

---

## 6. Premium voices (huge audio quality boost)

The default macOS voices (Samantha, Daniel) are decent but a bit robotic. The **Premium** voices (Ava, Allison, Tom, Evan, Noelle…) sound near-human.

To unlock them:

1. **System Settings** → **Accessibility** → **Spoken Content**
2. **System Voice** → **Customize…**
3. Expand **English (US)** (or your locale)
4. Check the boxes marked **(Premium)** — Ava, Allison, Tom, Evan, etc.
5. Click **OK**. They download in the background (~100 MB each).
6. Refresh Vox — they appear in the gear icon → Interviewer voice picker, marked with **★ Premium**.

---

## 7. Common gotchas

| Symptom | Fix |
|---|---|
| `/api/health` shows `auth: "api_key"` | `unset ANTHROPIC_API_KEY` and re-run `./run.sh` (the wrapper does this, but a leftover env value in the parent shell can leak in some setups). |
| First transcribe takes ~60s | Normal — Whisper is downloading and loading. Subsequent calls are ~1–2s. |
| Mic shows "permission denied" | Browser blocked the mic. Click the camera/mic icon in the address bar and re-allow. macOS may also need Terminal/browser to be granted mic access under System Settings → Privacy & Security → Microphone. |
| `claude` not found | Install Claude Code from https://docs.claude.com/en/docs/claude-code/quickstart, then `claude login`. |
| Server can't reach Claude | Run `claude` in a terminal to verify your login is working. If it asks you to log in, do so. |
| Voice picker shows only generic voices | Premium voices need to be downloaded — see §6 above. |
| "Backend TTS unavailable" in logs | You're on Linux/Windows where `say` doesn't exist. Vox falls back to browser TTS automatically. |
| Whisper model loads but transcription is slow | Try a smaller model: `WHISPER_MODEL=tiny.en ./run.sh`. Or, for better quality on a fast machine: `WHISPER_MODEL=medium.en`. |

---

## 8. Tunables (all optional, set in `.env` or shell)

```bash
# Model selection (defaults shown)
CLAUDE_INTERVIEWER_MODEL=claude-sonnet-4-6   # snappier turns
CLAUDE_EVALUATOR_MODEL=claude-opus-4-7       # best reasoning for final report
CLAUDE_RESUME_MODEL=claude-sonnet-4-6        # resume extraction
# Or set both at once:
# CLAUDE_MODEL=claude-sonnet-4-6

# Whisper
WHISPER_MODEL=small.en      # tiny.en | base.en | small.en (default) | medium.en | large-v3
WHISPER_DEVICE=auto         # auto | cpu | cuda | metal
WHISPER_COMPUTE=int8        # int8 (CPU) | float16 (GPU)

# Server
HOST=127.0.0.1
PORT=8000
```

---

## 9. Folder layout

```
Interview_voice_agent/
├── backend/
│   ├── main.py           # FastAPI app + all endpoints
│   ├── interviewer.py    # Claude-driven interviewer (job + study modes)
│   ├── evaluator.py      # Post-interview structured scoring
│   ├── tts.py            # macOS `say` wrapper
│   ├── stt.py            # faster-whisper wrapper
│   ├── resume.py         # PDF/DOCX text extraction + Claude profile parse
│   ├── models.py / session.py
├── frontend/             # index.html + style.css + app.js (no build step)
├── scripts/timing_test.py
├── setup.sh              # one-shot installer (this guide §2)
├── run.sh                # start the server
├── requirements.txt
├── .env.example
└── SETUP.md              # ← you are here
```

---

## 10. Stopping the server

`Ctrl+C` in the terminal where `./run.sh` is running.

If it's running in the background:
```bash
pkill -f "uvicorn backend.main:app"
```
