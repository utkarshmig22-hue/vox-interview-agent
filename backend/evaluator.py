"""Claude-powered evaluator. Returns a structured EvaluationReport.

Uses the Claude Agent SDK (your Claude Max plan via Claude Code).
"""

import asyncio
import json
import os
import re
from typing import Optional

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import AssistantMessage, TextBlock

# The evaluator is the heaviest single Claude call (full transcript + model
# answers per question). Give it more headroom than a turn.
EVAL_TIMEOUT_SECS = 180

from .models import CriterionScore, Difficulty, EvaluationReport, QuestionSolution, Turn


DEFAULT_EVALUATOR_MODEL = "claude-opus-4-7"


def _model() -> Optional[str]:
    """Model used for the post-interview evaluation.

    Defaults to Opus — the evaluation does multi-dimensional reasoning over
    the full transcript and produces model answers per question, where the
    extra reasoning capacity pays off. Override via CLAUDE_EVALUATOR_MODEL,
    or globally via CLAUDE_MODEL.
    """
    return (
        os.environ.get("CLAUDE_EVALUATOR_MODEL")
        or os.environ.get("CLAUDE_MODEL")
        or DEFAULT_EVALUATOR_MODEL
    )


EVAL_SYSTEM_PROMPT = """You are a senior hiring manager evaluating a candidate based on the transcript of a spoken interview.

You will receive: the topic, the difficulty level, optional role/context details, optional focus areas the candidate asked to be tested on, and the full transcript.

# Calibrate to the role
If a target role / context is provided, score against the bar for THAT role specifically — not a generic bar. A "Hire" for a Senior PM at a Series-B fintech is different from "Hire" for a Junior PM at a 50,000-person enterprise.

# Be charitable about transcription noise
The candidate spoke through speech-to-text. Obvious mis-transcribed words (homophones, mangled technical terms) should not count against them when the surrounding meaning is clear.

You will return ONLY a single JSON object — no prose, no markdown fences, no commentary outside the JSON. Use this exact schema:

{
  "overall_score": <integer 1-10>,
  "verdict": "Strong Hire" | "Hire" | "Lean No Hire" | "No Hire",
  "summary": "<2-4 sentence overall assessment>",
  "strengths": ["<concrete strength 1>", "<strength 2>", ...],
  "gaps": ["<concrete gap 1>", "<gap 2>", ...],
  "criteria": [
    {"name": "Technical Accuracy",       "score": <1-10>, "rationale": "<one sentence>"},
    {"name": "Depth of Understanding",   "score": <1-10>, "rationale": "<one sentence>"},
    {"name": "Communication Clarity",    "score": <1-10>, "rationale": "<one sentence>"},
    {"name": "Problem-Solving Approach", "score": <1-10>, "rationale": "<one sentence>"},
    {"name": "Confidence & Composure",   "score": <1-10>, "rationale": "<one sentence>"}
  ],
  "question_solutions": [
    {
      "question": "<the interviewer's question, verbatim or trimmed if very long>",
      "candidate_answer": "<the candidate's answer, verbatim or 'No answer given' if they didn't respond>",
      "model_answer": "<what a strong answer looks like — concrete, specific, useful as a teaching aid. 3-6 sentences. Include the key concepts, the right framework, and a concrete example or trade-off when relevant. Calibrate depth to the difficulty level.>",
      "feedback": "<one sentence comparing the candidate's answer to the model answer — what they got right, what they missed>"
    }
    // ...one entry for EVERY primary interviewer question, in order
  ]
}

# About question_solutions
This is the most important part of the report for the candidate's learning. For EVERY substantive question the interviewer asked (skip greetings, "thanks", pure acknowledgements), produce a model answer that the candidate can study. The model answer must be:
- Concrete and specific — NOT vague platitudes like "you should think about trade-offs"
- Useful as a teaching aid — name the actual concepts, frameworks, and considerations
- Calibrated to the stated difficulty
- 3-6 sentences. Conversational, not bulleted

Scoring guide (calibrated to the stated difficulty level):
- 9-10: exceptional, hire on the spot
- 7-8: strong, would hire
- 5-6: borderline, mixed evidence
- 3-4: noticeable weaknesses, lean no
- 1-2: not a fit for this level

Verdict mapping (use as a guideline, not a strict rule):
- overall 8-10 -> "Strong Hire"
- overall 6-7 -> "Hire"
- overall 4-5 -> "Lean No Hire"
- overall 1-3 -> "No Hire"

Ground every claim in specific things the candidate actually said. Be fair: short answers aren't necessarily bad if they're correct and complete.
"""


def _format_transcript(turns: list[Turn]) -> str:
    lines = []
    for t in turns:
        label = "Interviewer" if t.role == "interviewer" else "Candidate"
        lines.append(f"{label}: {t.content}")
    return "\n\n".join(lines)


def _extract_json(text: str) -> dict:
    """Pull the first JSON object out of the model's reply, tolerating stray text or code fences."""
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Evaluator did not return JSON. Got: {text[:300]}")
    return json.loads(match.group(0))


async def _collect_text(prompt: str, options: ClaudeAgentOptions) -> str:
    async def _run() -> str:
        chunks: list[str] = []
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
        return "".join(chunks).strip()

    try:
        return await asyncio.wait_for(_run(), timeout=EVAL_TIMEOUT_SECS)
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"Evaluation exceeded {EVAL_TIMEOUT_SECS}s timeout."
        )


async def evaluate(
    topic: str,
    difficulty: Difficulty,
    candidate_name: Optional[str],
    turns: list[Turn],
    role_context: Optional[str] = None,
    focus_areas: Optional[str] = None,
    mode: str = "job",
    study_material: Optional[str] = None,
    custom_criteria: Optional[list[str]] = None,
    response_times_ms: Optional[list[int]] = None,
) -> EvaluationReport:
    transcript = _format_transcript(turns)

    context_lines = [
        f"Mode: {mode}",
        f"Topic: {topic}",
        f"Difficulty: {difficulty}",
        f"{'Learner' if mode == 'study' else 'Candidate'}: {candidate_name or 'Anonymous'}",
    ]
    if role_context and role_context.strip():
        context_lines.append(f"Target role / context: {role_context.strip()}")
    if focus_areas and focus_areas.strip():
        context_lines.append(f"Focus areas to weight in scoring: {focus_areas.strip()}")

    extra = ""
    if mode == "study":
        extra = (
            "\n# IMPORTANT — study mode framing\n"
            "This was a STUDY session, not a hiring interview. Score how well the learner "
            "demonstrated understanding of the source material below, NOT hireability. "
            "The verdict labels (Strong Hire / Hire / Lean No Hire / No Hire) map to the "
            "learner's grasp: Strong Hire = mastered, Hire = solid grasp with minor gaps, "
            "Lean No Hire = significant gaps, No Hire = needs to review the basics. "
            "Use 'criteria' names appropriate for studying: 'Concept Accuracy', "
            "'Depth of Understanding', 'Communication Clarity', 'Application & Examples', "
            "'Confidence & Composure'. "
            "Model answers in `question_solutions` should explain what the MATERIAL says, "
            "not generic best practice.\n"
        )
        if study_material and study_material.strip():
            mat = study_material.strip()
            if len(mat) > 30000:
                mat = mat[:30000] + "\n[truncated]"
            extra += f"\n# Source material (the truth for this session)\n<material>\n{mat}\n</material>\n"

    if custom_criteria:
        cleaned = [c.strip() for c in custom_criteria if c and c.strip()][:8]
        if cleaned:
            extra += (
                "\n# Custom criteria override\n"
                "Use EXACTLY these criterion names in the `criteria` array (in this order), "
                f"replacing the default ones: {cleaned}\n"
            )
    if response_times_ms:
        avg = sum(response_times_ms) / max(1, len(response_times_ms))
        extra += (
            f"\n# Response timing observed\n"
            f"Average time-to-answer: {avg/1000:.1f}s across {len(response_times_ms)} turns. "
            "Factor this into Confidence & Composure (or analogous criterion) — long pauses on "
            "easy questions suggest uncertainty; quick answers on hard ones suggest fluency.\n"
        )

    user_prompt = (
        "\n".join(context_lines)
        + extra
        + f"\n\nTranscript:\n{transcript}\n\n"
        "Return the evaluation JSON now."
    )

    options = ClaudeAgentOptions(
        system_prompt=EVAL_SYSTEM_PROMPT,
        model=_model(),
        allowed_tools=[],
        max_turns=1,
    )
    raw = await _collect_text(prompt=user_prompt, options=options)
    data = _extract_json(raw)

    criteria = [CriterionScore(**c) for c in data["criteria"]]
    solutions = [QuestionSolution(**s) for s in data.get("question_solutions", [])]
    return EvaluationReport(
        candidate_name=candidate_name,
        topic=topic,
        difficulty=difficulty,
        overall_score=int(data["overall_score"]),
        verdict=data["verdict"],
        summary=data["summary"],
        strengths=list(data.get("strengths", [])),
        gaps=list(data.get("gaps", [])),
        criteria=criteria,
        question_solutions=solutions,
        transcript=turns,
    )
