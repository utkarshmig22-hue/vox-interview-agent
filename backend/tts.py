"""Backend text-to-speech using macOS `say`.

`say` uses the system's installed voices — including downloadable Premium /
Enhanced ones — which sound dramatically more natural than the browser's
Web Speech API. They respect commas, periods, and clause boundaries.

Returns WAV bytes so any browser can play it.
"""

import os
import re
import subprocess
import tempfile
from typing import Optional

# ---- Module-level caches (filled on first call, never re-fetched) ----
_available_cache: Optional[bool] = None
_voices_cache: dict[str, list[dict]] = {}

# -----------------------------------------------------------------------------
# Pronunciation map: words that `say` (and most TTS engines) mispronounce.
# Apply BEFORE handing the text to the synth.
# Format: regex pattern -> replacement.
# -----------------------------------------------------------------------------
PRONUNCIATIONS: list[tuple[str, str]] = [
    # --- Tech acronyms that should be spelled out ---
    (r"\bAPI(s)?\b", r"A.P.I.\1"),
    (r"\bUI\b", "U.I."),
    (r"\bUX\b", "U.X."),
    (r"\bIDE\b", "I.D.E."),
    (r"\bAWS\b", "A.W.S."),
    (r"\bGCP\b", "G.C.P."),
    (r"\bCDN\b", "C.D.N."),
    (r"\bDNS\b", "D.N.S."),
    (r"\bTLS\b", "T.L.S."),
    (r"\bSSL\b", "S.S.L."),
    (r"\bJWT\b", "J.W.T."),
    (r"\bSDK(s)?\b", r"S.D.K.\1"),
    (r"\bHTTP(S)?\b", r"H.T.T.P.\1"),
    (r"\bURL(s)?\b", r"U.R.L.\1"),
    (r"\bASGI\b", "A.S.G.I."),
    (r"\bWSGI\b", "W.S.G.I."),
    (r"\bnpm\b", "N.P.M."),
    (r"\bnpx\b", "N.P.X."),
    (r"\bk8s\b", "Kubernetes"),
    (r"\bkubectl\b", "kube control"),
    (r"\bLLM(s)?\b", r"L.L.M.\1"),
    (r"\bAI\b", "A.I."),
    (r"\bML\b", "M.L."),
    (r"\bRAG\b", "rag"),

    # --- Words pronounced as words (acronym -> word) ---
    (r"\bJSON\b", "Jay-son"),
    (r"\bYAML\b", "Yamel"),
    (r"\bSaaS\b", "sass"),
    (r"\bSQL\b", "sequel"),
    (r"\bMySQL\b", "My sequel"),
    (r"\bPostgreSQL\b", "Postgres sequel"),
    (r"\bNoSQL\b", "no sequel"),
    (r"\bOAuth\b", "O-auth"),
    (r"\bGitHub\b", "Git-hub"),
    (r"\bGitLab\b", "Git-lab"),
    (r"\bFAANG\b", "fang"),

    # --- Business / PM acronyms ---
    (r"\bCEO\b", "C.E.O."),
    (r"\bCTO\b", "C.T.O."),
    (r"\bCFO\b", "C.F.O."),
    (r"\bCMO\b", "C.M.O."),
    (r"\bCOO\b", "C.O.O."),
    (r"\bPM\b", "P.M."),
    (r"\bEM\b", "E.M."),
    (r"\bTPM\b", "T.P.M."),
    (r"\bKYC\b", "K.Y.C."),
    (r"\bAML\b", "A.M.L."),
    (r"\bGMV\b", "G.M.V."),
    (r"\bNPS\b", "N.P.S."),
    (r"\bROI\b", "R.O.I."),
    (r"\bMVP\b", "M.V.P."),
    (r"\bKPI(s)?\b", r"K.P.I.\1"),
    (r"\bOKR(s)?\b", r"O.K.R.\1"),
    (r"\bB2B\b", "B to B"),
    (r"\bB2C\b", "B to C"),
    (r"\bSMB\b", "S.M.B."),

    # --- Percentiles (P50, P90, P99) ---
    (r"\bP(\d+)\b", r"P \1"),

    # --- Strip stray markdown that might slip through ---
    (r"\*\*([^*]+)\*\*", r"\1"),
    (r"\*([^*]+)\*", r"\1"),
    (r"`([^`]+)`", r"\1"),

    # --- Improve pacing on dashes (em / en) → comma ---
    (r"\s+—\s+", ", "),
    (r"\s+–\s+", ", "),

    # --- Normalise multiple spaces ---
    (r"  +", " "),
]


def _preprocess(text: str) -> str:
    out = text
    for pattern, replacement in PRONUNCIATIONS:
        out = re.sub(pattern, replacement, out)
    return out.strip()


# -----------------------------------------------------------------------------
# Voice listing
# -----------------------------------------------------------------------------
def list_voices(language_prefix: str = "en_") -> list[dict]:
    """Return installed `say` voices filtered to the given language prefix.
    Cached per language_prefix — voice list doesn't change at runtime."""
    global _voices_cache
    if language_prefix in _voices_cache:
        return _voices_cache[language_prefix]
    try:
        result = subprocess.run(
            ["say", "-v", "?"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        _voices_cache[language_prefix] = []
        return []

    # Known "good" standard voices to surface above other standard voices.
    # These are real-sounding system voices; below them are old novelty voices.
    GOOD_STANDARD = {
        "Samantha", "Daniel", "Karen", "Alex", "Moira", "Veena", "Allison",
        "Fiona", "Tessa", "Susan", "Tom", "Aaron", "Nicky", "Fred", "Vicki",
        "Victoria", "Kate", "Rishi", "Serena", "Ava", "Allison", "Joelle",
    }
    # Novelty/joke voices that should sort last.
    NOVELTY = {
        "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos",
        "Deranged", "Good News", "Hysterical", "Jester", "Junior", "Kathy",
        "Organ", "Pipe Organ", "Princess", "Ralph", "Reed", "Superstar",
        "Trinoids", "Whisper", "Zarvox", "Wobble", "Bahh", "Eddy", "Flo",
        "Grandma", "Grandpa", "Rocko", "Sandy", "Shelley",
    }

    voices = []
    for line in result.stdout.splitlines():
        # Format: "Name              lang_REGION    # sample text"
        m = re.match(r"^(.+?)\s{2,}(\w+_\w+)\s*#", line)
        if not m:
            continue
        name = m.group(1).strip()
        lang = m.group(2).strip()
        if not lang.startswith(language_prefix):
            continue
        quality = (
            "premium" if "(Premium)" in name
            else "enhanced" if "(Enhanced)" in name
            else "standard"
        )
        # Tier within "standard": good > generic > novelty
        base_name = re.sub(r"\s*\([^)]+\)\s*", "", name).strip()
        if quality == "standard":
            if base_name in NOVELTY:
                tier = 4  # bottom
            elif base_name in GOOD_STANDARD:
                tier = 2  # good standard
            else:
                tier = 3  # generic standard
        elif quality == "enhanced":
            tier = 1
        else:  # premium
            tier = 0
        voices.append({"name": name, "lang": lang, "quality": quality, "_tier": tier})

    voices.sort(key=lambda v: (v["_tier"], v["name"]))
    for v in voices:
        v.pop("_tier", None)
    _voices_cache[language_prefix] = voices
    return voices


def is_available() -> bool:
    """Quick check that `say` is available on this system.
    Cached after first call — `say` either exists or doesn't, never changes."""
    global _available_cache
    if _available_cache is not None:
        return _available_cache
    try:
        subprocess.run(["say", "-v", "?"], capture_output=True, timeout=5, check=True)
        _available_cache = True
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        _available_cache = False
    return _available_cache


# -----------------------------------------------------------------------------
# Synthesis
# -----------------------------------------------------------------------------
def synthesize(text: str, voice: Optional[str] = None, rate: int = 175) -> bytes:
    """Synthesise WAV audio for the given text.

    `rate` is words per minute (default ~175 ≈ 1.0× normal). Lower = slower.
    Returns raw WAV bytes (16-bit PCM, 22050 Hz).
    """
    if not text or not text.strip():
        return b""
    processed = _preprocess(text)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        cmd = ["say"]
        if voice:
            cmd.extend(["-v", voice])
        if rate:
            cmd.extend(["-r", str(rate)])
        cmd.extend([
            "-o", out_path,
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            processed,
        ])
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
