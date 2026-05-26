#!/usr/bin/env bash
# Start Vox locally.

set -e

cd "$(dirname "$0")"

# We want to use the Claude Max plan via Claude Code OAuth, not API credits.
# An ANTHROPIC_API_KEY in the shell would override that — strip it for this process.
unset ANTHROPIC_API_KEY

if [ ! -f .env ]; then
  echo "[info] No .env found. Copying .env.example -> .env."
  cp .env.example .env
fi

# Activate venv if it exists
if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo "[info] Starting Vox at http://${HOST}:${PORT}"
exec uvicorn backend.main:app --reload --host "$HOST" --port "$PORT"
