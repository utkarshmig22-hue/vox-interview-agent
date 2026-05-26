"""End-to-end timing test mirroring the new frontend pipeline.

Simulates one user turn through Vox: user finishes speaking → ack TTS and
Claude /respond fire in parallel → wait for both → main TTS → audio ready.

Reports the perceptual numbers a real user would feel.
"""
import asyncio
import time

import aiohttp


BASE = "http://127.0.0.1:8000"
ACK_PHRASE = "Got it, let me think about that for a moment."
CANDIDATE_ANSWER = (
    "I'd start by understanding which corridor has the most demand, then look at "
    "regulatory complexity and partner availability. I'd score each option against "
    "those criteria with the team before the meeting so we're aligning on data, "
    "not opinions."
)


async def fetch_tts(session, text):
    t0 = time.time()
    async with session.post(
        f"{BASE}/api/tts",
        json={"text": text, "voice": "Samantha", "rate": 175},
    ) as r:
        body = await r.read()
    return time.time() - t0, len(body)


async def main():
    async with aiohttp.ClientSession() as session:
        print("=== Setup: starting interview ===")
        async with session.post(
            f"{BASE}/api/interview/start",
            json={
                "topic": "Product Management — payments",
                "difficulty": "intermediate",
                "target_questions": 5,
            },
        ) as r:
            data = await r.json()
            session_id = data["session_id"]
        print(f"  session_id: {session_id}")

        # Pre-warm acks (mirrors warmAcks() on frontend)
        print("\n=== Pre-warming ack cache ===")
        t0 = time.time()
        await fetch_tts(session, ACK_PHRASE)
        print(f"  warmup latency: {time.time() - t0:.2f}s")

        # The interesting bit: one full user-turn round-trip
        print("\n=== ONE FULL TURN — parallel ack + Claude ===")
        t_user_done = time.time()
        print(f"  t=0.00s  : user finishes speaking (VAD fires)")

        async def task_ack():
            return await fetch_tts(session, ACK_PHRASE)

        async def task_claude():
            t0 = time.time()
            async with session.post(
                f"{BASE}/api/interview/{session_id}/respond",
                json={"answer": CANDIDATE_ANSWER},
            ) as r:
                data = await r.json()
            return time.time() - t0, data["reply"]

        ack_task = asyncio.create_task(task_ack())
        claude_task = asyncio.create_task(task_claude())

        _, ack_bytes = await ack_task
        t_ack_ready = time.time() - t_user_done
        print(f"  t={t_ack_ready:.2f}s  : ack audio ready ({ack_bytes} bytes) — plays now")

        _, reply = await claude_task
        t_claude_done = time.time() - t_user_done
        print(f"  t={t_claude_done:.2f}s  : Claude returned ({len(reply)} chars)")
        print(f"           reply: {reply[:120]}...")

        # Now fetch main TTS for the reply
        main_dt, main_bytes = await fetch_tts(session, reply)
        t_main_ready = time.time() - t_user_done
        print(f"  t={t_main_ready:.2f}s  : main reply audio ready ({main_bytes} bytes)")

        # Perceptual analysis
        # The ack phrase used is ~10 words → ~3.4s of speech at 175 wpm
        ack_play_duration = 3.4
        ack_end_time = t_ack_ready + ack_play_duration
        gap = max(0, t_main_ready - ack_end_time)
        old_total = t_claude_done + main_dt

        print()
        print("=== Perceptual breakdown ===")
        print(f"  Ack starts:  t={t_ack_ready:.2f}s   — user hears speech right away")
        print(f"  Ack ends:    t={ack_end_time:.2f}s  (after ~{ack_play_duration}s of ack speech)")
        print(f"  Main starts: t={t_main_ready:.2f}s")
        print()
        print(f"  Old flow (no ack): {old_total:.2f}s of pure silence before any audio")
        print(f"  New flow:          {gap:.2f}s of silence between ack-end and main-start")
        improvement = old_total - gap
        print(f"  → {improvement:.1f}s of perceived silence eliminated ({improvement / old_total * 100:.0f}% reduction)")


asyncio.run(main())
