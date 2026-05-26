#!/usr/bin/env bash
# Vox · one-shot installer for a fresh machine.
# Run from inside the project directory:
#   bash setup.sh

set -euo pipefail

cd "$(dirname "$0")"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
warn()  { printf "\033[33m%s\033[0m\n" "$1"; }

bold "==> Vox setup"
echo

# -----------------------------------------------------------------------------
# 1. Prerequisite checks
# -----------------------------------------------------------------------------
bold "Step 1/5 — checking prerequisites"

if ! command -v python3 >/dev/null 2>&1; then
  red "✗ python3 not found. Install Python 3.10+ first (https://www.python.org/downloads/)."
  exit 1
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
green "✓ python3 found (version $PY_VER)"

if ! command -v claude >/dev/null 2>&1; then
  red "✗ Claude Code CLI (claude) not found on PATH."
  echo "  Install it from: https://docs.claude.com/en/docs/claude-code/quickstart"
  echo "  Then run 'claude login' and re-run this script."
  exit 1
fi
CLAUDE_VER=$(claude --version 2>/dev/null | head -1 || echo "unknown")
green "✓ Claude Code found: $CLAUDE_VER"

if [[ "$(uname)" == "Darwin" ]]; then
  if command -v say >/dev/null 2>&1; then
    green "✓ macOS 'say' available (used for high-quality TTS)"
  else
    warn "⚠ macOS detected but 'say' not found — TTS will fall back to browser engine."
  fi
else
  warn "⚠ Non-macOS host — backend TTS (macOS say) won't work; browser TTS will be used."
fi

# Warn if an API key is set — we want to use Max-plan OAuth, not paid API
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "⚠ ANTHROPIC_API_KEY is set in your shell."
  echo "  Vox will use it INSTEAD of your Max plan, which costs API credits."
  echo "  Run: unset ANTHROPIC_API_KEY    (in this terminal, before starting the server)"
fi

echo

# -----------------------------------------------------------------------------
# 2. Virtualenv
# -----------------------------------------------------------------------------
bold "Step 2/5 — creating virtualenv (.venv/)"

if [[ -d .venv ]]; then
  green "✓ .venv already exists — reusing it"
else
  python3 -m venv .venv
  green "✓ Created .venv"
fi

# shellcheck disable=SC1091
source .venv/bin/activate
green "✓ Activated .venv"
echo

# -----------------------------------------------------------------------------
# 3. Python deps
# -----------------------------------------------------------------------------
bold "Step 3/5 — installing Python dependencies (this can take a few minutes)"
pip install --upgrade pip --quiet
pip install --quiet -r requirements.txt
green "✓ All dependencies installed"
echo

# -----------------------------------------------------------------------------
# 4. .env
# -----------------------------------------------------------------------------
bold "Step 4/5 — config (.env)"
if [[ -f .env ]]; then
  green "✓ .env already exists — leaving it alone"
else
  cp .env.example .env
  green "✓ Wrote .env from template (no API key needed — uses your Max plan)"
fi
echo

# -----------------------------------------------------------------------------
# 5. Pre-warm caches
# -----------------------------------------------------------------------------
bold "Step 5/5 — pre-warming the Whisper model (downloads ~500MB on first run)"
python3 -c "
import sys
try:
    from faster_whisper import WhisperModel
    print('Downloading/loading small.en model...', flush=True)
    m = WhisperModel('small.en', device='auto', compute_type='int8')
    print('Whisper ready.')
except Exception as e:
    print(f'Could not pre-warm Whisper: {e}', file=sys.stderr)
    sys.exit(0)  # non-fatal; will load on first request
" || true
echo

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
bold "Setup complete."
echo
echo "Start the server with:"
echo "  unset ANTHROPIC_API_KEY    # ensures Max-plan auth"
echo "  ./run.sh                   # OR: source .venv/bin/activate && uvicorn backend.main:app --port 8000"
echo
echo "Then open: http://127.0.0.1:8000"
echo
warn "Tip: for the most human-sounding voice, install a Premium macOS voice via"
warn "     System Settings → Accessibility → Spoken Content → System Voice →"
warn "     Customize → English → check 'Ava (Premium)' or 'Tom (Premium)'."
