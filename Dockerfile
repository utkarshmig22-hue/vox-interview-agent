# Vox — single-container deploy
# Build:  docker build -t vox .
# Run:    docker run -p 8000:8000 -v ~/.claude:/root/.claude vox
#         (mount your Claude Code creds so the Agent SDK works)

FROM python:3.12-slim

# Whisper needs ffmpeg under the hood for some formats
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Pre-download the default Whisper model so first request is fast.
# (Skip this layer if you'd rather lazy-load to keep the image smaller.)
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')"

COPY backend ./backend
COPY frontend ./frontend
COPY scripts ./scripts

ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000

# Note: macOS `say` won't exist inside Linux containers — the backend
# auto-falls back to browser TTS. For cloud deploys, install Piper
# externally or use a different TTS backend.

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
