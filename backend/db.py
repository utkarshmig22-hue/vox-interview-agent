"""SQLite persistence — single file under data/vox.db.

Stores:
  - sessions (full JSON state per session, so we can pause/resume across restarts)
  - audio_clips (candidate voice recordings per turn, for playback in the report)

Stdlib only; no extra deps.
"""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

_DB_DIR = Path(__file__).resolve().parent.parent / "data"
_DB_PATH = _DB_DIR / "vox.db"
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _lock, _conn() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                finished INTEGER NOT NULL DEFAULT 0,
                topic TEXT,
                mode TEXT,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_finished ON sessions(finished);

            CREATE TABLE IF NOT EXISTS audio_clips (
                session_id TEXT NOT NULL,
                turn_index INTEGER NOT NULL,
                mime TEXT NOT NULL,
                audio BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, turn_index)
            );

            CREATE TABLE IF NOT EXISTS shares (
                token TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);

            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_token TEXT NOT NULL,
                turn_index INTEGER,
                author TEXT,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_comments_token ON comments(share_token);
        """)


# ---- Shares & comments (mentor mode) ------------------------------------
def create_share(session_id: str) -> str:
    import secrets
    token = secrets.token_urlsafe(12)
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO shares (token, session_id, created_at) VALUES (?,?,?)",
            (token, session_id, int(time.time())),
        )
    return token


def get_share(token: str) -> Optional[str]:
    with _conn() as c:
        row = c.execute("SELECT session_id FROM shares WHERE token=?", (token,)).fetchone()
    return row["session_id"] if row else None


def add_comment(share_token: str, body: str, *, author: Optional[str] = None,
                turn_index: Optional[int] = None) -> dict:
    with _lock, _conn() as c:
        cur = c.execute(
            """INSERT INTO comments (share_token, turn_index, author, body, created_at)
               VALUES (?,?,?,?,?)""",
            (share_token, turn_index, author, body, int(time.time())),
        )
        cid = cur.lastrowid
    return {"id": cid}


def list_comments(share_token: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            """SELECT id, turn_index, author, body, created_at
               FROM comments WHERE share_token=? ORDER BY created_at ASC""",
            (share_token,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---- Sessions ------------------------------------------------------------
def upsert_session(session_id: str, data: dict, *, finished: bool = False,
                   topic: str = "", mode: str = "job") -> None:
    now = int(time.time())
    payload = json.dumps(data, default=str)
    with _lock, _conn() as c:
        existing = c.execute("SELECT created_at FROM sessions WHERE id=?", (session_id,)).fetchone()
        created = existing["created_at"] if existing else now
        c.execute(
            """INSERT OR REPLACE INTO sessions
               (id, created_at, updated_at, finished, topic, mode, data)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (session_id, created, now, 1 if finished else 0, topic, mode, payload),
        )


def get_session(session_id: str) -> Optional[dict]:
    with _conn() as c:
        row = c.execute("SELECT data FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        return None
    return json.loads(row["data"])


def list_sessions(*, only_finished: Optional[bool] = None, limit: int = 100) -> list[dict]:
    """List sessions, newest first. `only_finished=True` for completed,
    `False` for in-progress, `None` for all."""
    sql = "SELECT id, created_at, updated_at, finished, topic, mode FROM sessions"
    params: list[Any] = []
    if only_finished is True:
        sql += " WHERE finished = 1"
    elif only_finished is False:
        sql += " WHERE finished = 0"
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)
    with _conn() as c:
        rows = c.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def delete_session(session_id: str) -> None:
    with _lock, _conn() as c:
        c.execute("DELETE FROM audio_clips WHERE session_id=?", (session_id,))
        c.execute("DELETE FROM sessions WHERE id=?", (session_id,))


# ---- Audio clips ---------------------------------------------------------
def save_audio(session_id: str, turn_index: int, audio: bytes, mime: str) -> None:
    with _lock, _conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO audio_clips
               (session_id, turn_index, mime, audio, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (session_id, turn_index, mime, sqlite3.Binary(audio), int(time.time())),
        )


def get_audio(session_id: str, turn_index: int) -> Optional[tuple[bytes, str]]:
    with _conn() as c:
        row = c.execute(
            "SELECT mime, audio FROM audio_clips WHERE session_id=? AND turn_index=?",
            (session_id, turn_index),
        ).fetchone()
    if not row:
        return None
    return bytes(row["audio"]), row["mime"]


# ---- Spaced repetition: gap aggregation ---------------------------------
def aggregate_gaps(limit_sessions: int = 20) -> list[dict]:
    """Walk recent finished sessions, pull `gaps` out of each report, return
    them with topic/date context so the user can re-attack their weak spots."""
    with _conn() as c:
        rows = c.execute(
            """SELECT id, topic, updated_at, data FROM sessions
               WHERE finished=1 ORDER BY updated_at DESC LIMIT ?""",
            (limit_sessions,),
        ).fetchall()
    out = []
    for r in rows:
        try:
            d = json.loads(r["data"])
            report = d.get("_report") or {}
            for gap in report.get("gaps", []):
                out.append({
                    "session_id": r["id"],
                    "topic": r["topic"] or "",
                    "date": r["updated_at"],
                    "gap": gap,
                })
        except Exception:
            continue
    return out
