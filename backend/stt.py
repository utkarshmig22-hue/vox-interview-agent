"""Local speech-to-text via faster-whisper.

Far better than browser Web Speech: handles punctuation natively, gets
tech terms right (API, JSON, FastAPI, K8s), corrects spelling, no API key
needed. Runs entirely on your machine.

Model loads lazily on first request and stays warm in memory for the
process lifetime.

Configurable via env:
  WHISPER_MODEL    = "small.en" (default) | tiny.en | base.en | medium.en | large-v3
  WHISPER_DEVICE   = "auto" (default) | cpu | cuda | metal
  WHISPER_COMPUTE  = "int8" (CPU default) | float16 (GPU)
"""

import os
import tempfile
import threading
from typing import Optional

# Lazy import — only imported when actually used.
_WhisperModel = None

_model = None
_model_lock = threading.Lock()
_model_size = os.environ.get("WHISPER_MODEL", "small.en")


def is_available() -> bool:
    """Return True if faster-whisper is installed (model not yet loaded)."""
    try:
        global _WhisperModel
        if _WhisperModel is None:
            from faster_whisper import WhisperModel as _W
            _WhisperModel = _W
        return True
    except ImportError:
        return False


def _get_model():
    """Load (and cache) the Whisper model. First call may take ~10–60s
    while the weights are downloaded; subsequent calls are instant."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:
            if not is_available():
                raise RuntimeError("faster-whisper is not installed")
            device = os.environ.get("WHISPER_DEVICE", "auto")
            compute_type = os.environ.get("WHISPER_COMPUTE", "int8")
            _model = _WhisperModel(_model_size, device=device, compute_type=compute_type)
    return _model


def info() -> dict:
    """Lightweight status info for /api/health."""
    return {
        "available": is_available(),
        "model": _model_size,
        "loaded": _model is not None,
    }


def transcribe(audio_bytes: bytes, mime: str = "audio/webm", language: str = "en") -> str:
    """Transcribe an audio blob and return the cleaned text.

    Uses internal VAD filter to skip silence, beam search for accuracy,
    and the language is locked to English (we run the .en models)."""
    if not audio_bytes:
        return ""

    # Pick a sensible suffix so ffmpeg can identify the format.
    suffix = ".webm"
    if "wav" in mime:
        suffix = ".wav"
    elif "mp4" in mime or "m4a" in mime:
        suffix = ".m4a"
    elif "ogg" in mime:
        suffix = ".ogg"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        path = tmp.name

    try:
        model = _get_model()
        segments, _info = model.transcribe(
            path,
            language=language or "en",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            # Whisper handles punctuation automatically when this is on
            # (it's on by default but be explicit):
            word_timestamps=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return text
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def warm() -> None:
    """Preload the model in a background thread so the first user request
    isn't slowed down by initial model load."""
    if not is_available():
        return

    def _bg():
        try:
            _get_model()
        except Exception as e:
            print(f"[warn] Whisper warm-up failed: {e}")

    threading.Thread(target=_bg, daemon=True).start()
