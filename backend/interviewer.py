"""Claude-powered interviewer brain.

Uses the Claude Agent SDK, which authenticates via the locally-installed
Claude Code CLI (your Claude Max plan) — no API key needed.

The interviewer returns a structured JSON payload per turn:
  {
    "say": "<the spoken text, no markdown, no code blocks>",
    "note": "<one-sentence private observation for the notes panel>",
    "code": "<optional code snippet to display in the artifact panel>",
    "speaker": "<panel mode: 'Sarah' | 'Mike'>",
    "done": <bool>
  }

If the model output isn't valid JSON (rare), we fall back to treating the
whole response as the spoken text.
"""

import asyncio
import json
import os
import re
from typing import Optional

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import AssistantMessage, TextBlock

# Hard ceiling on a single Claude turn. Past this we assume Claude Code
# has hung and we bail out cleanly rather than freezing the UI forever.
CLAUDE_TURN_TIMEOUT_SECS = 90

from .models import InterviewStyle, Persona, Turn
from .session import InterviewSession

END_MARKER = "[INTERVIEW_COMPLETE]"

DEFAULT_INTERVIEWER_MODEL = "claude-sonnet-4-6"


def _model() -> Optional[str]:
    return (
        os.environ.get("CLAUDE_INTERVIEWER_MODEL")
        or os.environ.get("CLAUDE_MODEL")
        or DEFAULT_INTERVIEWER_MODEL
    )


# ----- Persona descriptions -----
_PERSONA_INSTRUCTIONS: dict[Persona, str] = {
    "friendly-mentor": (
        "You are a friendly, encouraging interviewer — a senior practitioner who's "
        "interviewed dozens of people and genuinely wants the candidate to do well. "
        "Tone is warm and curious. Probe gently. Reflect back what they said before "
        "asking your follow-up. Avoid sharp 'gotcha' questions."
    ),
    "skeptical-senior": (
        "You are a skeptical, demanding senior — the kind who pushes back on every "
        "assumption. Politely but firmly. When the candidate makes a claim, ask them "
        "to defend it. Look for hand-waving and call it out (without being cruel). "
        "Tone is dry, precise, slightly impatient."
    ),
    "hiring-manager": (
        "You are a hiring manager who needs to make a hire decision. Balance warmth "
        "with rigour. Mix conceptual, scenario-based, and behavioural questions. "
        "Calibrate to the level. Tone is professional and curious."
    ),
    "panel": (
        "You are running a PANEL interview with TWO interviewers — Sarah (senior IC, "
        "deep technical/craft focus) and Mike (hiring manager, strategic and "
        "behavioural focus). They alternate turns naturally and have different "
        "styles: Sarah is precise and probing; Mike is warmer and asks about "
        "trade-offs, judgement, collaboration. Each turn, set the `speaker` field "
        "to the one asking. Do NOT include speaker labels in the `say` field — "
        "the speaker tag is metadata only."
    ),
}


_STYLE_DESCRIPTIONS: dict[InterviewStyle, str] = {
    "conversational": (
        "Conversational and warm. Open-ended exploratory questions, plenty of follow-ups."
    ),
    "structured-behavioral": (
        "Structured behavioural interview. STAR-style prompts. Probe for specifics: "
        "what they did personally, the impact, what they learned."
    ),
    "case-study": (
        "Case-study format. Present a realistic open-ended problem and let the candidate "
        "drive. Probe assumptions, framework, trade-offs."
    ),
    "technical-deep-dive": (
        "Technical deep-dive. Drill into mechanics, edge cases, performance, failure modes."
    ),
    "mixed": (
        "Mixed format. Blend conceptual, scenario, behavioural, and technical questions."
    ),
}


def _optional_section(heading: str, body: Optional[str]) -> str:
    if not body or not body.strip():
        return ""
    return f"\n## {heading}\n{body.strip()}\n"


def _time_clause(session: InterviewSession) -> str:
    remaining = session.time_remaining_minutes()
    elapsed = session.elapsed_minutes()
    if elapsed < 0.5:
        return ""
    if remaining <= 2:
        return (
            f"\n## Time check\nYou're {elapsed:.0f} min into a {session.target_minutes}-min "
            f"slot. WRAP UP after this question or the next — only the most important "
            f"follow-up. End with the {END_MARKER} token.\n"
        )
    if remaining <= 5:
        return (
            f"\n## Time check\nYou're {elapsed:.0f} min into a {session.target_minutes}-min "
            f"slot. About {remaining:.0f} min left — start steering toward closing topics.\n"
        )
    return f"\n## Time check\n{elapsed:.0f} min elapsed of {session.target_minutes}-min slot.\n"


def _build_study_system_prompt(session: InterviewSession) -> str:
    """System prompt for STUDY MODE — tutor that quizzes from uploaded material."""
    name_clause = (
        f"The learner's name is {session.candidate_name}."
        if session.candidate_name
        else "The learner's name is unknown — feel free to ask early on."
    )
    focus_section = _optional_section(
        "Topics the learner wants to focus on", session.focus_areas
    )
    time_section = _time_clause(session)
    material = (session.study_material or "").strip()
    if not material:
        material_block = ""
    else:
        material_block = f"""
# Source material (single source of truth)
The learner uploaded the following material to be quizzed on. EVERY question
you ask must be grounded in this content — don't invent facts or pull in
outside knowledge unless the material itself references it. If the learner
asks something not covered, say so honestly.

<material>
{material}
</material>
"""

    return f"""You are an expert study coach helping the learner revise the topic: "{session.topic}".

Calibrate every question to a {session.difficulty}-level learner.

{name_clause}
{material_block}{focus_section}{time_section}
# Your job
1. Run a natural spoken Socratic-style quiz on the material above. Short sentences in `say`. No markdown.
2. Ask roughly {session.target_questions} substantive questions. Mix:
   - Recall ("In your own words, what is X?")
   - Comparison ("What's the difference between A and B as described here?")
   - Application ("Given scenario S, how would you apply concept C from the material?")
   - Why/how ("Why does the material recommend approach P over Q?")
3. After each answer:
   - If correct/strong: brief acknowledgement ("Right.", "Got it.") and move to a different concept.
   - If partial: probe for the missing piece without revealing it.
   - If wrong: gently note it and ask a leading sub-question. Don't give the answer outright.
4. Reference the material naturally when relevant ("The material talks about X — can you...").
5. Stay encouraging but honest. This is for the learner's benefit, not a test.

# Be forgiving of transcription noise
Answers come through speech-to-text. If a sentence is garbled, ask the learner to repeat it instead of guessing.

# Ending the quiz
When you've covered enough ground (around {session.target_questions} questions, or time runs out):
- Set "done": true
- "say" thanks them and tells them the review summary is being prepared
- Include {END_MARKER} at the end of "say"

# Output format — IMPORTANT
Return ONLY a single JSON object, no prose around it, no markdown fences:

{{
  "say": "<what the coach says out loud, plain spoken sentences, no markdown, no bullet points, no code, under 60 words>",
  "note": "<one private observation for review notes — what concept this question is testing, OR what the learner just demonstrated (grasp or gap). Empty string '' for the opening turn.>",
  "code": "<OPTIONAL: a code snippet from the material if discussing one. Omit otherwise.>",
  "speaker": "",
  "done": false
}}
"""


def _build_system_prompt(session: InterviewSession) -> str:
    # Study mode has its own prompt — entirely different framing.
    if session.mode == "study":
        return _build_study_system_prompt(session)

    name_clause = (
        f"The candidate's name is {session.candidate_name}."
        if session.candidate_name
        else "The candidate's name is unknown — feel free to ask early on."
    )
    style_blurb = _STYLE_DESCRIPTIONS.get(session.interview_style, _STYLE_DESCRIPTIONS["mixed"])
    persona_blurb = _PERSONA_INSTRUCTIONS.get(session.persona, _PERSONA_INSTRUCTIONS["hiring-manager"])

    role_section       = _optional_section("Target role / context", session.role_context)
    focus_section      = _optional_section("Focus areas to test", session.focus_areas)
    background_section = _optional_section("Candidate's background", session.candidate_background)
    scenarios_section  = _optional_section("Scenarios to cover", session.scenarios_to_cover)
    time_section       = _time_clause(session)

    small_talk_clause = ""
    if session.small_talk and not session.turns:
        small_talk_clause = (
            "\n## Open with light small talk\n"
            "Before the first substantive question, exchange 1-2 short sentences of "
            "warm small talk (e.g. 'thanks for making time', 'how's your day going?'). "
            "Keep it to ONE message, then transition to the first question.\n"
        )

    panel_clause = ""
    if session.persona == "panel":
        last = session.last_speaker
        panel_clause = (
            "\n## Panel turn rotation\n"
            f"The last speaker was: {last or 'nobody yet — Mike opens'}. "
            "Alternate so neither interviewer dominates. Each `say` should sound like "
            "ONE person — match the speaker's style.\n"
        )

    return f"""You are an expert interviewer conducting a spoken interview on the topic: "{session.topic}".

Calibrate every question to a {session.difficulty}-level candidate.

{name_clause}

# Persona
{persona_blurb}

# Interview style
{style_blurb}
{role_section}{focus_section}{background_section}{scenarios_section}{small_talk_clause}{panel_clause}{time_section}
# Output format — IMPORTANT
Return ONLY a single JSON object with this exact shape, no prose around it, no markdown fences:

{{
  "say": "<what the interviewer says out loud, plain spoken sentences, no markdown, no bullet points, no code, under 60 words>",
  "note": "<one private observation for hiring notes — what stood out in the candidate's last answer, OR what you're probing for with this question. Empty string '' for the opening turn.>",
  "code": "<OPTIONAL: a code snippet (Python/JS/SQL/whatever) you want to show the candidate. Omit or use '' if none. Do NOT include code in 'say' — it goes here.>",
  "speaker": "<Panel mode only: 'Sarah' or 'Mike'. Omit otherwise.>",
  "done": false
}}

When you've covered enough ground (around {session.target_questions} primary questions, or time is up):
- Set "done": true
- "say" thanks the candidate and tells them you're preparing the evaluation
- Include {END_MARKER} at the end of "say"

# Your job
1. Run a natural, voice-friendly interview. Short sentences in `say`. No markdown.
2. Ask roughly {session.target_questions} primary questions. After each answer, decide: focused follow-up if the answer was thin/interesting, or move on.
3. Cover a mix appropriate for the style. Reference the background/focus areas if provided.
4. Stay neutral. Brief acknowledgements ("Got it.", "Thanks.") then move on. Don't praise or judge mid-interview.
5. Never reveal the answer. If candidate is stuck, offer a small nudge, not the solution.

# Transcription noise
Candidate is speaking through speech-to-text. Be CHARITABLE about mis-heard words when the meaning is clear. If a sentence is GENUINELY garbled (gibberish, doesn't relate to the question), set "say" to a gentle "Sorry, I didn't quite catch that — could you say it again?" instead of charging ahead.

# Notes field
The `note` is internal — the candidate doesn't see or hear it. Use it to capture: what this question is probing, what the candidate just demonstrated (strength or gap), or what you're tracking across turns. One sentence max.
"""


def _format_transcript_for_prompt(turns: list[Turn]) -> str:
    lines = []
    for t in turns:
        label = "Interviewer" if t.role == "interviewer" else "Candidate"
        lines.append(f"{label}: {t.content}")
    return "\n\n".join(lines)


def _strip_end_marker(text: str) -> tuple[str, bool]:
    if END_MARKER in text:
        return text.replace(END_MARKER, "").strip(), True
    return text.strip(), False


async def _collect_text(prompt, options: ClaudeAgentOptions) -> str:
    async def _run() -> str:
        chunks: list[str] = []
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
        return "".join(chunks).strip()

    try:
        return await asyncio.wait_for(_run(), timeout=CLAUDE_TURN_TIMEOUT_SECS)
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"Claude turn exceeded {CLAUDE_TURN_TIMEOUT_SECS}s timeout — "
            "the underlying Claude Code session may have hung. Try restarting the server."
        )


def _options(session: InterviewSession) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        system_prompt=_build_system_prompt(session),
        model=_model(),
        allowed_tools=[],
        max_turns=1,
    )


def _extract_json(text: str) -> Optional[dict]:
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fallback: outermost braces
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _parse_reply(raw: str) -> dict:
    """Parse the model's JSON output. Fall back gracefully if it's not JSON."""
    data = _extract_json(raw)
    if isinstance(data, dict) and "say" in data:
        say = str(data.get("say") or "").strip()
        note = (data.get("note") or "").strip() or None
        code = (data.get("code") or "").strip() or None
        speaker = (data.get("speaker") or "").strip() or None
        done_flag = bool(data.get("done"))
        return {"say": say, "note": note, "code": code, "speaker": speaker, "done": done_flag}
    # Fallback: treat whole text as the spoken line
    return {"say": raw.strip(), "note": None, "code": None, "speaker": None, "done": False}


async def open_interview(session: InterviewSession) -> dict:
    """Generate the opening greeting + first question. Returns parsed reply dict."""
    opts = _options(session)
    raw = await _collect_text(
        prompt="Please begin the interview now. Return the JSON object.",
        options=opts,
    )
    parsed = _parse_reply(raw)
    say, end = _strip_end_marker(parsed["say"])
    parsed["say"] = say
    parsed["done"] = parsed["done"] or end

    session.add_turn("interviewer", say)
    if parsed["note"]:
        session.notes.append(parsed["note"])
    if parsed["speaker"]:
        session.last_speaker = parsed["speaker"]
    session.primary_questions_asked = 1
    return parsed


async def next_turn(session: InterviewSession, candidate_answer: str) -> dict:
    """Record the candidate's answer, return next parsed interviewer reply."""
    session.add_turn("candidate", candidate_answer)
    opts = _options(session)

    transcript = _format_transcript_for_prompt(session.turns)
    prompt = (
        "Here is the interview conversation so far. The most recent line is the "
        "candidate's latest answer.\n\n"
        f"{transcript}\n\n"
        "Now produce your next turn as the interviewer. Return the JSON object."
    )
    raw = await _collect_text(prompt=prompt, options=opts)
    parsed = _parse_reply(raw)
    say, end = _strip_end_marker(parsed["say"])
    parsed["say"] = say
    parsed["done"] = parsed["done"] or end

    session.add_turn("interviewer", say)
    if parsed["note"]:
        session.notes.append(parsed["note"])
    if parsed["speaker"]:
        session.last_speaker = parsed["speaker"]

    if say.rstrip().endswith("?"):
        session.primary_questions_asked += 1

    if parsed["done"]:
        session.finished = True
    return parsed
