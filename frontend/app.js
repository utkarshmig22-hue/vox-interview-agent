// Vox — AI Voice Interviewer · frontend logic
// Web Speech API (STT + TTS) <-> FastAPI backend.
// Real-time feel: sentence-by-sentence TTS, auto-listen, auto-send-on-silence,
// interrupt, voice picker, speed control.

const API = {
  start: "/api/interview/start",
  respond: (id) => `/api/interview/${id}/respond`,
  finish: (id) => `/api/interview/${id}/finish`,
  transcribe: (lang) => `/api/transcribe?language=${encodeURIComponent(lang || "en")}`,
  health: "/api/health",
  sessions: (status) => `/api/sessions?status=${status}`,
  resume: (id) => `/api/interview/${id}/resume`,
  audioSave: (id, idx) => `/api/interview/${id}/audio/${idx}`,
  audioGet: (id, idx) => `/api/interview/${id}/audio/${idx}`,
  weakSpots: "/api/weak-spots",
  packs: "/api/question-packs",
  share: (id) => `/api/interview/${id}/share`,
  shareGet: (tok) => `/api/share/${tok}`,
  shareComments: (tok) => `/api/share/${tok}/comments`,
  voices: (lang) => `/api/voices?lang=${encodeURIComponent(lang || "en_")}`,
};

const state = {
  sessionId: null,
  topic: "",
  difficulty: "intermediate",
  interviewStyle: "mixed",
  persona: "hiring-manager",

  // STT — Whisper preferred, browser fallback
  whisperAvailable: false,
  mediaRecorder: null,
  mediaStream: null,
  recordingChunks: [],
  recordingStart: 0,
  transcribing: false,

  recognition: null,  // browser fallback
  recognising: false,
  speaking: false,
  awaitingReply: false,

  // Browser Web Speech voices (fallback)
  voices: [],
  preferredVoice: null,

  // Backend TTS state (preferred when available)
  backendTTSAvailable: false,
  backendVoices: [],          // [{name, lang, quality}]
  currentAudio: null,         // active main HTMLAudioElement so we can cancel
  ackAudio: null,             // active ack HTMLAudioElement
  vad: null,                  // active VAD instance

  // Clock
  startedAt: null,            // ms timestamp of interview start
  targetMinutes: 15,
  clockTimer: null,

  // Panel mode: voice mapping per speaker
  panelVoices: {},            // {"Sarah": "Samantha", "Mike": "Daniel"}
  lastSpeaker: null,

  // Audio-reactive orb / avatar lip-sync
  orbAnalyser: null,
  orbAudioCtx: null,
  orbRaf: null,
  blinkTimer: null,

  // Current report (for saving to history)
  currentReport: null,

  silenceTimer: null,
  speechFinishedFlag: false,

  // Mic-press transcript buffers
  finalisedTextBeforeMic: "",
  finalisedFromMic: "",
  interimText: "",
};

const SETTINGS_KEY = "vox.settings.v1";
const settings = {
  voiceName: null,        // user's chosen voice (persisted)
  rate: 0.95,             // 1.0 = default, slightly slower sounds less robotic
  pitch: 1.0,
  autoListen: true,       // arm mic when interviewer finishes
  autoSendOnSilence: false, // OFF by default — user always reviews/edits before sending
  silenceSeconds: 0.8,    // VAD silence threshold (was 2.5 with timer-based)
  acknowledgements: true, // play "Mhm.", "Got it." while Claude thinks
  language: "en",         // Whisper STT language
  theme: "dark",          // dark | light
  camera: false,          // show self-view picture-in-picture
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (_) {}
  // Migrate old defaults: silenceSeconds used to be 2.5 with a coarse timer.
  // The new VAD detector reacts to actual mic energy, so values > 3 don't
  // really make sense — clamp them down to the new default.
  if (settings.silenceSeconds > 3) settings.silenceSeconds = 0.8;
  // One-time migration: auto-send was previously on by default. We've flipped
  // it to opt-in so the user always reviews before sending. Reset once for
  // users carrying the old default forward.
  if (!settings._autoSendDefaultMigrated) {
    settings.autoSendOnSilence = false;
    settings._autoSendDefaultMigrated = true;
    saveSettings();
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const screens = {
  setup: $("setup-screen"),
  interview: $("interview-screen"),
  report: $("report-screen"),
  history: $("history-screen"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setState(kind, text) {
  const pill = $("status-pill");
  pill.className = "pill pill-" + kind;
  $("status-text").textContent = text;
  const orb = $("orb");
  if (orb) orb.className = "orb orb-" + kind;
}

function setMicLabel(label) {
  $("mic-label").textContent = label;
}

function appendTurn(role, text, { turnIndex = null } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `turn ${role}`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "interviewer" ? "Interviewer" : "You";
  // Candidate turns get a ▶ button to replay their own audio.
  if (role === "candidate" && turnIndex !== null && state.sessionId) {
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "turn-play-btn";
    playBtn.title = "Play your recording";
    playBtn.dataset.session = state.sessionId;
    playBtn.dataset.turn = String(turnIndex);
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
    playBtn.addEventListener("click", () => playTurnAudio(playBtn));
    label.appendChild(playBtn);
  }
  const body = document.createElement("div");
  body.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(body);
  const t = $("transcript");
  t.appendChild(wrap);
  t.scrollTop = t.scrollHeight;
}

// ---------- Voice playback of candidate turns ----------
async function playTurnAudio(btn) {
  const sid = btn.dataset.session;
  const idx = btn.dataset.turn;
  try {
    btn.classList.add("playing");
    const r = await fetch(API.audioGet(sid, idx));
    if (!r.ok) throw new Error("No recording");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { btn.classList.remove("playing"); URL.revokeObjectURL(url); };
    audio.onerror = () => { btn.classList.remove("playing"); URL.revokeObjectURL(url); };
    await audio.play();
  } catch (e) {
    btn.classList.remove("playing");
    btn.title = "No recording stored for this turn";
  }
}

// ---------- Browser capability check ----------
function detectCapabilities() {
  const hasRecorder = !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const TTS = "speechSynthesis" in window;
  const hint = $("browser-hint");
  const issues = [];
  if (!hasRecorder && !SR) issues.push("voice input (no MediaRecorder or SpeechRecognition — you can still type)");
  if (!TTS) issues.push("voice output (interviewer will only display text)");
  hint.textContent = issues.length ? "Your browser doesn't support " + issues.join(", or ") + "." : "";
  return { hasRecorder, hasSTT: !!SR, hasTTS: TTS };
}

// Probe the backend for Whisper STT availability.
async function probeWhisper() {
  try {
    const r = await fetch(API.health);
    if (!r.ok) return false;
    const data = await r.json();
    state.whisperAvailable = !!data.stt_backend;
    return state.whisperAvailable;
  } catch (_) { return false; }
}

// ---------- Voice picking ----------
// Order of preference for a "human-sounding" voice. Mac names: "Ava (Premium)",
// "Allison (Premium)", "Tom (Premium)". Chrome: "Google US English".
// Windows: "Microsoft Aria Online (Natural)", "Microsoft Jenny Online (Natural)".
const VOICE_PRIORITIES = [
  /Premium/i,
  /Enhanced/i,
  /Natural/i,
  /Neural/i,
  /Online \(Natural\)/i,
  /Google US English/i,
  /Microsoft.*Online/i,
  /Samantha/i,
  /^en-US/i,
  /^en/i,
];

function rankVoice(v) {
  const tag = `${v.lang} ${v.name}`;
  for (let i = 0; i < VOICE_PRIORITIES.length; i++) {
    if (VOICE_PRIORITIES[i].test(tag)) return i;
  }
  return VOICE_PRIORITIES.length;
}

function loadVoices() {
  state.voices = window.speechSynthesis.getVoices()
    .filter(v => /^en/i.test(v.lang))
    .sort((a, b) => {
      const ra = rankVoice(a), rb = rankVoice(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

  // Only resolve browser preferredVoice if backend isn't available.
  if (!state.backendTTSAvailable) {
    if (settings.voiceName) {
      state.preferredVoice = state.voices.find(v => v.name === settings.voiceName) || state.voices[0];
    } else {
      state.preferredVoice = state.voices[0];
      if (state.preferredVoice) settings.voiceName = state.preferredVoice.name;
    }
  }

  populateVoicePicker();
  updateVoiceTip();
}

// Probe the backend for the macOS `say` voice list. When available, we use it
// preferentially over the browser's Web Speech voices because the audio quality
// (prosody, comma pauses, pronunciation) is dramatically better.
async function loadBackendVoices() {
  try {
    const r = await fetch("/api/voices");
    if (!r.ok) return;
    const data = await r.json();
    if (!data.available || !data.voices || !data.voices.length) return;
    state.backendTTSAvailable = true;
    state.backendVoices = data.voices;

    // Initial pick: persisted setting, else first (top of sort = best quality).
    const persisted = settings.voiceName;
    const found = persisted ? data.voices.find(v => v.name === persisted) : null;
    if (!found) {
      settings.voiceName = data.voices[0].name;
      saveSettings();
    }
    populateVoicePicker();
    updateVoiceTip();
  } catch (e) {
    // Backend TTS not reachable — silently stick with Web Speech.
    console.debug("Backend TTS probe failed:", e);
  }
}

function populateVoicePicker() {
  const sel = $("voice-picker");
  if (!sel) return;
  sel.innerHTML = "";

  // Prefer backend voices when available — they sound dramatically better.
  if (state.backendTTSAvailable && state.backendVoices.length) {
    for (const v of state.backendVoices) {
      const opt = document.createElement("option");
      opt.value = v.name;
      const badge =
        v.quality === "premium" ? " ★ Premium"
        : v.quality === "enhanced" ? " ◆ Enhanced"
        : "";
      opt.textContent = `${v.name}${badge} (${v.lang})`;
      if (v.name === settings.voiceName) opt.selected = true;
      sel.appendChild(opt);
    }
    return;
  }

  if (!state.voices.length) {
    const opt = document.createElement("option");
    opt.textContent = "No voices available";
    sel.appendChild(opt);
    return;
  }
  for (const v of state.voices) {
    const opt = document.createElement("option");
    opt.value = v.name;
    const quality = /Premium|Enhanced|Natural|Neural|Online \(Natural\)/i.test(v.name) ? " ★" : "";
    opt.textContent = `${v.name}${quality} (${v.lang})`;
    if (state.preferredVoice && v.name === state.preferredVoice.name) opt.selected = true;
    sel.appendChild(opt);
  }
}

function updateVoiceTip() {
  const tip = $("voice-tip");
  if (!tip) return;

  if (state.backendTTSAvailable) {
    const v = state.backendVoices.find(x => x.name === settings.voiceName);
    if (!v) { tip.textContent = ""; return; }
    const hasPremium = state.backendVoices.some(x => x.quality === "premium" || x.quality === "enhanced");
    if (v.quality === "premium") {
      tip.className = "settings-hint";
      tip.textContent = "★ Premium voice — uses your macOS native engine for very natural pronunciation and prosody.";
    } else if (v.quality === "enhanced") {
      tip.className = "settings-hint";
      tip.textContent = "◆ Enhanced voice — uses your macOS native engine. Natural pacing and clear punctuation.";
    } else if (!hasPremium) {
      tip.className = "settings-hint warn";
      tip.textContent = "Using macOS native engine (handles commas & periods properly). For an even more human voice, install a Premium voice: System Settings → Accessibility → Spoken Content → System Voice → Customize → English → check 'Premium' voices (e.g. Ava, Allison, Tom).";
    } else {
      tip.className = "settings-hint";
      tip.textContent = "Using macOS native engine. Pick a ★ Premium or ◆ Enhanced voice above for the most human sound.";
    }
    return;
  }

  // Fallback: browser Web Speech tip
  const v = state.preferredVoice;
  if (!v) { tip.textContent = ""; return; }
  const isPremium = /Premium|Enhanced|Natural|Neural|Online \(Natural\)/i.test(v.name);
  if (isPremium) {
    tip.className = "settings-hint";
    tip.textContent = "★ High-quality natural voice (browser engine).";
  } else {
    tip.className = "settings-hint warn";
    tip.textContent = "Browser-engine voice. The macOS engine sounds much better — start the backend server to enable it.";
  }
}

// ---------- Sentence parsing + tone hints ----------
function splitSentences(text) {
  const matches = text.match(/[^.!?;]+[.!?;]+(?=\s|$)|[^.!?;]+$/g);
  if (!matches) return [text.trim()].filter(Boolean);
  return matches.map(s => s.trim()).filter(Boolean);
}

// Tone heuristic: nudge wpm slightly per sentence so delivery isn't monotone.
// Returns a wpm-multiplier (0.92–1.08).
function sentenceToneMultiplier(sentence, idx, total) {
  const s = sentence.trim();
  if (!s) return 1.0;
  // Questions → slightly slower (~0.94)
  if (s.endsWith("?")) return 0.94;
  // Short acknowledgements → slightly faster, more clipped
  if (/^(Got it|Right|OK|Sure|Thanks|Mhm)[.!]?$/i.test(s)) return 1.06;
  // Transitional / softening phrases → slightly faster
  if (/^(So|Now|Alright|Let me|Let's|Walk me)/i.test(s)) return 1.03;
  // Curious / probing markers → slower
  if (/\b(interesting|tell me more|what about|why|how come)\b/i.test(s)) return 0.95;
  // Final sentence of a reply → slow down a hair (natural close)
  if (idx === total - 1 && total > 1) return 0.96;
  return 1.0;
}

// ---------- Instant acknowledgements ----------
// Quick "Got it." / "Mhm." / "Right." while Claude is generating the actual
// reply. Pre-warmed on session start so the audio starts within ~50ms of the
// user finishing — the gap between human and bot disappears.
const ACK_PHRASES_SHORT = ["Got it.", "Mhm.", "OK.", "Right.", "Sure."];
const ACK_PHRASES_LONG = [
  "Got it, let me think about that for a moment.",
  "Mhm, interesting. Let me think about that.",
  "OK, give me a sec to think.",
  "Right, let me think about that for a second.",
  "Mhm, that's interesting. One sec while I think.",
  "Got it. Let me think through what you just said.",
  "OK, interesting. Let me sit with that for a moment.",
  "Right, thanks. Let me think about how to follow up.",
];
const ackCache = new Map(); // phrase -> Blob (pre-fetched WAV)

async function warmAcks() {
  if (!state.backendTTSAvailable) return;
  const wpm = Math.round(175 * settings.rate);
  // Pre-warm a small subset (3 short + 3 long). The rest get fetched lazily on
  // first use. macOS `say` is CPU-heavy — firing 13 in parallel stalled the
  // whole machine on session start.
  const shortSubset = ACK_PHRASES_SHORT.slice(0, 3);
  const longSubset = [...ACK_PHRASES_LONG].sort(() => Math.random() - 0.5).slice(0, 3);
  const phrases = [...shortSubset, ...longSubset];

  // Sequential, not parallel — one `say` at a time keeps the CPU calm.
  for (const phrase of phrases) {
    const key = `${phrase}|${settings.voiceName}|${wpm}`;
    if (ackCache.has(key)) continue;
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: phrase, voice: settings.voiceName, rate: wpm }),
      });
      if (r.ok) ackCache.set(key, await r.blob());
    } catch (_) {}
  }
}

function pickAck() {
  // Heavily bias toward longer acks so they fill more of the ~4s Claude wait.
  // ~80% long, 20% short. Short acks still appear occasionally for variety.
  const pool = Math.random() < 0.8 ? ACK_PHRASES_LONG : ACK_PHRASES_SHORT;
  return pool[Math.floor(Math.random() * pool.length)];
}

function playAck() {
  return new Promise(async (resolve) => {
    if (!settings.acknowledgements || !state.backendTTSAvailable) return resolve();
    const phrase = pickAck();
    const wpm = Math.round(175 * settings.rate);
    let blob = ackCache.get(`${phrase}|${settings.voiceName}|${wpm}`);
    if (!blob) {
      // Cache miss — synth on the fly (still fast, <1s)
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: phrase, voice: settings.voiceName, rate: wpm }),
        });
        if (!r.ok) return resolve();
        blob = await r.blob();
        ackCache.set(`${phrase}|${settings.voiceName}|${wpm}`, blob);
      } catch (_) {
        return resolve();
      }
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.ackAudio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      if (state.ackAudio === audio) state.ackAudio = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function cancelAck() {
  if (state.ackAudio) {
    try { state.ackAudio.pause(); } catch (_) {}
    state.ackAudio = null;
  }
}

// Backend-TTS speech: fetch the WAV from /api/tts, play via HTMLAudioElement.
// Sounds dramatically better than Web Speech — natural prosody, proper pauses
// on commas/periods, correct pronunciation of tech terms (preprocessed server-side).
// Backend TTS via macOS `say`. For natural delivery:
// - If the reply is multiple sentences, we synthesise them ONE-AT-A-TIME
//   (sequential, not parallel — `say` doesn't parallelise) so we can apply
//   per-sentence rate variation (questions slower, transitions faster, etc.).
// - If it's a single sentence, just one request — no chunking overhead.
// `voiceOverride` is used in panel mode to swap between two voices per turn.
function speakViaBackend(text, voiceOverride) {
  return new Promise(async (resolve) => {
    let cancelled = false;
    state._cancelSpeak = () => {
      cancelled = true;
      if (state.currentAudio) {
        try { state.currentAudio.pause(); } catch (_) {}
        state.currentAudio = null;
      }
      stopOrbReactivity();
      state.speaking = false;
      resolve();
    };

    const voice = voiceOverride || settings.voiceName;
    const baseWpm = 175 * settings.rate;

    try {
      const sentences = splitSentences(text);

      // Single sentence — just one request, no variation needed.
      if (sentences.length <= 1) {
        const wpm = Math.round(baseWpm);
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentences[0] || text, voice, rate: wpm }),
        });
        if (cancelled) return resolve();
        if (!r.ok) throw new Error(`/api/tts ${r.status}`);
        const blob = await r.blob();
        if (cancelled) return resolve();
        await playBlob(blob);
        return resolve();
      }

      // Multi-sentence: sequential, with tone-aware rate variation per sentence.
      for (let i = 0; i < sentences.length; i++) {
        if (cancelled) return resolve();
        const mult = sentenceToneMultiplier(sentences[i], i, sentences.length);
        const wpm = Math.round(baseWpm * mult);
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentences[i], voice, rate: wpm }),
        });
        if (cancelled) return resolve();
        if (!r.ok) continue;
        const blob = await r.blob();
        if (cancelled) return resolve();
        await playBlob(blob);
      }
      resolve();
    } catch (err) {
      console.warn("Backend TTS failed, falling back to Web Speech:", err);
      state._cancelSpeak = null;
      await speakViaBrowser(text);
      resolve();
    }
  });
}

// Play one Blob; returns when it finishes (or fails). Wires the orb analyser.
function playBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.currentAudio = audio;
    const done = () => {
      URL.revokeObjectURL(url);
      if (state.currentAudio === audio) state.currentAudio = null;
      stopOrbReactivity();
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    startOrbReactivity(audio);
    audio.play().catch((err) => { console.warn("Audio play failed:", err); done(); });
  });
}

function speakViaBrowser(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) return resolve();
    try { window.speechSynthesis.cancel(); } catch (_) {}

    const sentences = splitSentences(text);
    let idx = 0;
    let cancelled = false;

    function speakNext() {
      if (cancelled || idx >= sentences.length) { resolve(); return; }
      const sentence = sentences[idx++];
      const u = new SpeechSynthesisUtterance(sentence);
      if (state.preferredVoice) u.voice = state.preferredVoice;
      u.rate = settings.rate;
      u.pitch = settings.pitch;
      u.onend = () => speakNext();
      u.onerror = () => speakNext();
      window.speechSynthesis.speak(u);
    }

    state._cancelSpeak = () => {
      cancelled = true;
      try { window.speechSynthesis.cancel(); } catch (_) {}
      resolve();
    };

    speakNext();
  });
}

async function speak(text, { voiceOverride } = {}) {
  if (!text) return;
  state.speaking = true;
  state.speechFinishedFlag = false;
  setState("speaking", "Speaking");

  if (state.backendTTSAvailable) {
    await speakViaBackend(text, voiceOverride);
  } else {
    await speakViaBrowser(text);
  }

  state.speaking = false;
  state.speechFinishedFlag = true;
  state._cancelSpeak = null;
}

// ---------- Audio-reactive avatar (lip-sync) ----------
// Hook an AnalyserNode to the playing audio so the avatar's mouth opens with
// real waveform amplitude, and apply low/mid-frequency split for shape:
//   - Overall amplitude → mouth height (ry)
//   - Mid-band ratio    → mouth width (rx) — wider for "ah/eh", narrower for "ooh"
// Plus subtle face scaling so the whole head reacts.
function startOrbReactivity(audioEl) {
  try {
    stopOrbReactivity();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.orbAudioCtx = new Ctx();
    const src = state.orbAudioCtx.createMediaElementSource(audioEl);
    const analyser = state.orbAudioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    src.connect(state.orbAudioCtx.destination);
    state.orbAnalyser = analyser;

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const avatar = document.getElementById("avatar");
    const mouth = document.getElementById("mouth");
    const smile = document.getElementById("smile");
    if (!avatar || !mouth) return;

    // Hide the resting smile while speaking — the dynamic mouth takes over.
    if (smile) smile.setAttribute("opacity", "0");

    // Frequency-bin midpoint for the low/mid split (~600Hz at 22050 Hz / 512 fft)
    const midBinStart = Math.floor(analyser.frequencyBinCount * 0.06);
    const midBinEnd   = Math.floor(analyser.frequencyBinCount * 0.30);

    const tick = () => {
      if (!state.orbAnalyser) return;
      state.orbAnalyser.getByteFrequencyData(buf);

      // Overall amplitude → 0..1
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const amp = (sum / buf.length) / 255;

      // Mid-band energy → 0..1 (drives mouth width)
      let mid = 0;
      for (let i = midBinStart; i < midBinEnd; i++) mid += buf[i];
      const midNorm = (mid / (midBinEnd - midBinStart)) / 255;

      // Mouth height: 2 (closed) → 14 (wide-open vowel)
      const ry = 2 + Math.min(12, amp * 22);
      // Mouth width: 13 (rest) ± 4 based on mid-band
      const rx = 13 + (midNorm - 0.3) * 8;
      mouth.setAttribute("ry", ry.toFixed(2));
      mouth.setAttribute("rx", Math.max(8, Math.min(20, rx)).toFixed(2));

      // Face scale 1.0 → 1.05 — subtle, like breath/emphasis
      const scale = 1 + Math.min(0.06, amp * 0.16);
      avatar.style.transform = `scale(${scale.toFixed(3)})`;

      state.orbRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    // createMediaElementSource can only be called once per element — silently skip on reuse.
    console.debug("Avatar reactivity failed:", e);
  }
}

function stopOrbReactivity() {
  if (state.orbRaf) { cancelAnimationFrame(state.orbRaf); state.orbRaf = null; }
  if (state.orbAudioCtx) {
    try { state.orbAudioCtx.close(); } catch (_) {}
    state.orbAudioCtx = null;
  }
  state.orbAnalyser = null;
  // Reset to a resting mouth shape.
  const mouth = document.getElementById("mouth");
  if (mouth) {
    mouth.setAttribute("ry", "2");
    mouth.setAttribute("rx", "13");
  }
  const avatar = document.getElementById("avatar");
  if (avatar) avatar.style.transform = "";
  // Restore the resting smile if persona uses one (CSS handles which personas).
  const smile = document.getElementById("smile");
  if (smile) smile.removeAttribute("opacity");
}

// ---------- Idle face behaviours (blink, etc.) ----------
function startAvatarIdle() {
  if (state.blinkTimer) return;
  const blink = () => {
    const eyes = document.getElementById("eyes");
    if (eyes) {
      eyes.classList.add("blink");
      setTimeout(() => eyes.classList.remove("blink"), 120);
    }
    // Schedule next blink: 2.5 – 6 seconds, with occasional double-blink
    const next = 2500 + Math.random() * 3500;
    state.blinkTimer = setTimeout(() => {
      if (Math.random() < 0.15) {
        // Double-blink
        blink();
        setTimeout(blink, 220);
      } else {
        blink();
      }
    }, next);
  };
  state.blinkTimer = setTimeout(blink, 1500);
}
function stopAvatarIdle() {
  if (state.blinkTimer) { clearTimeout(state.blinkTimer); state.blinkTimer = null; }
}

function setAvatarPersona(persona) {
  const orb = document.getElementById("orb");
  if (!orb) return;
  orb.setAttribute("data-persona", persona || "hiring-manager");
}

// ---------- Panel-mode voice picking ----------
// Two distinct voices alternating. Picks reasonable defaults from the backend
// voice list (one female-leaning, one male-leaning where possible).
function ensurePanelVoices() {
  if (Object.keys(state.panelVoices).length === 2) return;
  const voices = state.backendVoices;
  if (!voices.length) return;
  // Prefer Samantha + Daniel if available, else fall back.
  const sarah =
    voices.find(v => v.name === "Samantha") ||
    voices.find(v => /Samantha|Allison|Ava|Karen|Tessa/i.test(v.name)) ||
    voices[0];
  const mike =
    voices.find(v => v.name === "Daniel") ||
    voices.find(v => /Daniel|Tom|Evan|Aaron|Fred|Rishi/i.test(v.name)) ||
    voices[1] || voices[0];
  state.panelVoices = { Sarah: sarah.name, Mike: mike.name };
}

function voiceForSpeaker(speaker) {
  if (!speaker) return undefined;
  ensurePanelVoices();
  return state.panelVoices[speaker];
}

// ---------- Clock ----------
function startClock(targetMinutes) {
  state.startedAt = Date.now();
  state.targetMinutes = targetMinutes;
  if (state.clockTimer) clearInterval(state.clockTimer);
  const tick = () => {
    const elapsedMs = Date.now() - state.startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    const pill = $("clock-pill");
    const txt = $("clock-text");
    if (txt) txt.textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (pill) {
      pill.classList.remove("warn", "over");
      const elapsedMin = elapsedMs / 60000;
      if (elapsedMin > state.targetMinutes) pill.classList.add("over");
      else if (elapsedMin > state.targetMinutes - 3) pill.classList.add("warn");
    }
  };
  tick();
  state.clockTimer = setInterval(tick, 1000);
}
function stopClock() {
  if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
}

// ---------- Notes panel ----------
function appendNote(note) {
  if (!note || !note.trim()) return;
  const list = $("notes-list");
  if (!list) return;
  const empty = list.querySelector(".notes-empty");
  if (empty) empty.remove();
  const item = document.createElement("div");
  item.className = "note-item";
  const elapsedSec = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  item.innerHTML = `<span class="note-time">${m}:${String(s).padStart(2, "0")}</span>${escapeHTML(note)}`;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function clearNotes() {
  const list = $("notes-list");
  if (!list) return;
  list.innerHTML = '<div class="notes-empty">Notes will appear here as the interview progresses…</div>';
}

// ---------- Code artifact ----------
function showCodeArtifact(code) {
  if (!code || !code.trim()) return;
  const card = $("code-card");
  const block = $("code-block").querySelector("code");
  if (!card || !block) return;
  block.textContent = code;
  card.classList.remove("hidden");
}
function clearCodeArtifact() {
  const card = $("code-card");
  if (card) card.classList.add("hidden");
  const block = $("code-block")?.querySelector("code");
  if (block) block.textContent = "";
}

// ---------- Speaker pill (panel mode) ----------
function setSpeaker(speaker) {
  const pill = $("speaker-pill");
  const txt = $("speaker-text");
  const chip = $("avatar-speaker-chip");
  if (!speaker) {
    if (pill) pill.classList.add("hidden");
    if (chip) chip.classList.add("hidden");
    return;
  }
  if (pill) pill.classList.remove("hidden");
  if (txt) txt.textContent = speaker;
  if (chip) {
    chip.classList.remove("hidden");
    chip.textContent = speaker;
  }
  state.lastSpeaker = speaker;
}

// ---------- Practice history ----------
const HISTORY_KEY = "vox.history.v1";

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch (_) { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-50))); } catch (_) {}
}
function pushHistory(report) {
  const arr = loadHistory();
  arr.push({
    id: Date.now().toString(36),
    savedAt: new Date().toISOString(),
    topic: report.topic,
    difficulty: report.difficulty,
    candidate_name: report.candidate_name,
    overall_score: report.overall_score,
    verdict: report.verdict,
    report,  // full report stored verbatim so we can re-render it
  });
  saveHistory(arr);
}

async function renderHistory() {
  const list = $("history-list");
  if (!list) return;
  const items = loadHistory().slice().reverse();
  // Progress dashboard at top
  renderProgress(items);

  // Also fetch in-progress sessions from the backend (separate from finished history).
  let inProgress = [];
  try {
    const r = await fetch(API.sessions("in_progress"));
    if (r.ok) inProgress = (await r.json()).sessions || [];
  } catch (_) {}

  if (!items.length && !inProgress.length) {
    list.innerHTML = '<div class="history-empty">No interviews yet — finish or start one and it\'ll show up here.</div>';
    return;
  }
  list.innerHTML = "";

  // In-progress section
  if (inProgress.length) {
    const lbl = document.createElement("div");
    lbl.className = "history-section-label";
    lbl.textContent = "In progress";
    list.appendChild(lbl);
    for (const s of inProgress) {
      const row = document.createElement("div");
      row.className = "history-item in-progress";
      const when = new Date(s.updated_at * 1000);
      row.innerHTML = `
        <div class="history-score">↻</div>
        <div class="history-meta-main">
          <div class="history-topic">${escapeHTML(s.topic || "Untitled")}</div>
          <div class="history-meta">${s.mode === "study" ? "Study" : "Job"} · paused ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
        <button type="button" class="btn-primary btn-sm history-resume">Resume</button>
      `;
      row.querySelector(".history-resume").addEventListener("click", (e) => {
        e.stopPropagation();
        resumeSession(s.id);
      });
      list.appendChild(row);
    }
  }

  // Finished section
  if (items.length) {
    const lbl = document.createElement("div");
    lbl.className = "history-section-label";
    lbl.textContent = "Completed";
    list.appendChild(lbl);
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "history-item";
    const when = new Date(it.savedAt);
    const niceDate = when.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      + " · " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `
      <div class="history-score">${it.overall_score}</div>
      <div class="history-meta-main">
        <div class="history-topic">${escapeHTML(it.topic || "")}</div>
        <div class="history-meta">${escapeHTML(it.candidate_name || "Anonymous")} · ${escapeHTML(it.difficulty)} · ${niceDate}</div>
      </div>
      <div class="history-verdict-tag ${verdictClass(it.verdict)}">${escapeHTML(it.verdict)}</div>
    `;
    row.addEventListener("click", () => {
      state.currentReport = it.report;
      renderReport(it.report);
      showScreen("report");
    });
    list.appendChild(row);
  }
}

function cancelSpeech() {
  // Cancel any in-flight acknowledgement audio first.
  cancelAck();
  if (state._cancelSpeak) state._cancelSpeak();
  else {
    try { window.speechSynthesis.cancel(); } catch (_) {}
    if (state.currentAudio) {
      try { state.currentAudio.pause(); } catch (_) {}
      state.currentAudio = null;
    }
    state.speaking = false;
  }
}

// ---------- Voice Activity Detection (VAD) ----------
// Web Audio API mic-energy monitor. Triggers a callback when the user stops
// speaking — typically within ~700ms — instead of waiting on a fixed timer.
// More natural turn-taking. Coexists with SpeechRecognition (separate mic
// capture; browsers allow this).
class VAD {
  constructor({ silenceMs = 800, voiceThreshold = 0.012, onSilence } = {}) {
    this.silenceMs = silenceMs;
    this.voiceThreshold = voiceThreshold;
    this.onSilence = onSilence;
    this.running = false;
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.tickId = null;
    this.lastVoiceTs = 0;
    this.everSpoke = false;
    this.fired = false;
  }

  async start() {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn("VAD getUserMedia failed:", e);
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audioContext = new Ctx();
    if (this.audioContext.state === "suspended") {
      try { await this.audioContext.resume(); } catch (_) {}
    }
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.3;
    source.connect(this.analyser);

    this.running = true;
    this.lastVoiceTs = Date.now();
    this.everSpoke = false;
    this.fired = false;
    const buf = new Float32Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.running) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);

      if (rms > this.voiceThreshold) {
        this.lastVoiceTs = Date.now();
        this.everSpoke = true;
        this.fired = false;
      } else if (this.everSpoke && !this.fired) {
        const silentFor = Date.now() - this.lastVoiceTs;
        if (silentFor >= this.silenceMs) {
          this.fired = true;
          try { this.onSilence && this.onSilence(); } catch (_) {}
        }
      }
    };
    // 50ms cadence — responsive without burning CPU
    this.tickId = setInterval(tick, 50);
  }

  stop() {
    this.running = false;
    if (this.tickId) { clearInterval(this.tickId); this.tickId = null; }
    if (this.stream) {
      this.stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      this.stream = null;
    }
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (_) {}
      this.audioContext = null;
    }
    this.analyser = null;
  }
}

// ---------- Speech recognition ----------
function buildRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

// Route to Whisper (preferred) or the browser SpeechRecognition fallback.
function startListening({ silent = false } = {}) {
  if (state.awaitingReply || state.transcribing) return;
  if (state.speaking) cancelSpeech();
  if (state.whisperAvailable && window.MediaRecorder) {
    startWhisperRecording(silent);
  } else {
    startBrowserRecognition(silent);
  }
}

function stopListening() {
  if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
    try { state.mediaRecorder.stop(); } catch (_) {}
  } else if (state.recognition && state.recognising) {
    try { state.recognition.stop(); } catch (_) {}
  }
  clearSilenceTimer();
  if (state.vad) { state.vad.stop(); state.vad = null; }
}

// ---------- Whisper recorder (MediaRecorder + /api/transcribe) ----------
async function startWhisperRecording(silent) {
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.warn("getUserMedia failed:", e);
    if (!silent) alert("Microphone permission was denied. Please allow it or type your answer.");
    return;
  }

  // Pick the best supported MIME for browser → Whisper handoff.
  let mimeType = "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
  }
  state.mediaRecorder = new MediaRecorder(state.mediaStream, mimeType ? { mimeType } : {});
  state.recordingChunks = [];
  state.recordingStart = Date.now();

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.recordingChunks.push(e.data);
  };
  state.mediaRecorder.onstop = () => handleWhisperStop();

  state.mediaRecorder.start();
  state.recognising = true;
  onListenStart();

  // Snapshot existing text in the box so Whisper output appends to it cleanly.
  const ta = $("text-answer");
  const cur = ta.value.trimEnd();
  state.finalisedTextBeforeMic = cur ? cur + " " : "";

  // VAD for snappy auto-stop on silence (when auto-send is on).
  if (settings.autoSendOnSilence && !state.vad) {
    state.vad = new VAD({
      silenceMs: Math.max(400, Math.round(settings.silenceSeconds * 1000)),
      voiceThreshold: 0.012,
      onSilence: () => {
        if (state.mediaRecorder && state.mediaRecorder.state === "recording") {
          stopListening();
        }
      },
    });
    state.vad.start();
  }
}

async function handleWhisperStop() {
  // Tear down the stream
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    state.mediaStream = null;
  }
  state.recognising = false;
  if (state.vad) { state.vad.stop(); state.vad = null; }

  const mimeType = state.mediaRecorder?.mimeType || "audio/webm";
  state.mediaRecorder = null;

  const blob = new Blob(state.recordingChunks, { type: mimeType });
  state.recordingChunks = [];
  // Hold onto this blob so we can upload it once we know the turn index
  // (i.e. after sendAnswer has done its appendTurn). We'll wire it in below.
  state._lastCandidateAudio = blob;

  if (blob.size < 1024) {
    // Too short to be real speech — bail
    onListenEnd("Recording was too short.");
    return;
  }

  // UI: show transcribing state
  state.transcribing = true;
  setState("thinking", "Transcribing…");
  $("answer-hint").textContent = "Transcribing with Whisper…";
  $("answer-hint").classList.remove("listening");
  $("mic-btn").disabled = true;

  try {
    const fd = new FormData();
    fd.append("file", blob, "recording.webm");
    const r = await fetch(API.transcribe(settings.language), { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`${r.status} ${err}`);
    }
    const data = await r.json();
    const text = (data.text || "").trim();
    if (text) {
      const ta = $("text-answer");
      ta.value = state.finalisedTextBeforeMic + text;
      ta.dispatchEvent(new Event("input"));
    }
    onListenEnd("Review and edit, then click Send.");

    // If auto-send is on AND we got text, send it.
    if (settings.autoSendOnSilence && text && !state.awaitingReply) {
      const full = $("text-answer").value.trim();
      if (full) {
        $("answer-hint").textContent = "Sending…";
        setTimeout(() => { if (!state.awaitingReply) sendAnswer(full); }, 80);
      }
    }
  } catch (e) {
    console.warn("Transcription failed:", e);
    $("answer-hint").textContent = "Couldn't transcribe — please try again or type your answer.";
    onListenEnd();
  } finally {
    state.transcribing = false;
    $("mic-btn").disabled = false;
  }
}

function onListenStart() {
  setState("listening", "Listening");
  setMicLabel("Listening — tap to stop");
  $("mic-btn").classList.add("recording");
  $("text-answer").classList.add("listening");
  $("answer-hint").classList.add("listening");
  $("answer-hint").textContent = settings.autoSendOnSilence
    ? `Listening — will stop & transcribe on ${settings.silenceSeconds}s of silence.`
    : "Listening — tap the mic again to stop, then review and Send.";
}

function onListenEnd(hintText) {
  $("mic-btn").classList.remove("recording");
  $("text-answer").classList.remove("listening");
  $("answer-hint").classList.remove("listening");
  setMicLabel("Hold to talk");
  if (hintText) $("answer-hint").textContent = hintText;
  if (!state.awaitingReply && !state.speaking) setState("idle", "Idle — your turn");
}

// ---------- Browser SpeechRecognition fallback ----------
function startBrowserRecognition(silent) {
  if (!state.recognition) {
    state.recognition = buildRecognition();
    if (!state.recognition) {
      if (!silent) alert("Speech recognition isn't available in this browser. Type your answer instead.");
      return;
    }
    wireRecognition(state.recognition);
  }
  const ta = $("text-answer");
  const cur = ta.value.trimEnd();
  state.finalisedTextBeforeMic = cur ? cur + " " : "";
  state.finalisedFromMic = "";
  state.interimText = "";
  try { state.recognition.start(); } catch (_) {}

  if (settings.autoSendOnSilence && !state.vad) {
    state.vad = new VAD({
      silenceMs: Math.max(300, Math.round(settings.silenceSeconds * 1000)),
      voiceThreshold: 0.012,
      onSilence: () => {
        const text = $("text-answer").value.trim();
        if (text && !state.awaitingReply && state.recognising) {
          $("answer-hint").textContent = "Sending…";
          stopListening();
          setTimeout(() => { if (!state.awaitingReply) sendAnswer(text); }, 80);
        }
      },
    });
    state.vad.start();
  }
}

function paintAnswer() {
  const ta = $("text-answer");
  const finalised = state.finalisedTextBeforeMic + state.finalisedFromMic;
  const interim = state.interimText
    ? (finalised.endsWith(" ") ? "" : " ") + state.interimText
    : "";
  ta.value = finalised + interim;
  ta.scrollTop = ta.scrollHeight;
  refreshSendBtnState();
}

function refreshSendBtnState() {
  $("send-text-btn").disabled = state.awaitingReply || !$("text-answer").value.trim();
}

function clearSilenceTimer() {
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }
}

function armSilenceTimer() {
  clearSilenceTimer();
  if (!settings.autoSendOnSilence || settings.silenceSeconds <= 0) return;
  state.silenceTimer = setTimeout(() => {
    const text = $("text-answer").value.trim();
    if (text && !state.awaitingReply && state.recognising) {
      $("answer-hint").textContent = "Sending after silence…";
      stopListening();
      // Small grace period so the user can interrupt by typing/pressing Send
      setTimeout(() => {
        if (text && !state.awaitingReply) sendAnswer(text);
      }, 150);
    }
  }, settings.silenceSeconds * 1000);
}

function wireRecognition(rec) {
  rec.onstart = () => {
    state.recognising = true;
    setState("listening", "Listening");
    setMicLabel("Listening — tap to stop");
    $("mic-btn").classList.add("recording");
    $("text-answer").classList.add("listening");
    $("answer-hint").classList.add("listening");
    $("answer-hint").textContent = settings.autoSendOnSilence
      ? `Listening — will auto-send after ${settings.silenceSeconds}s of silence.`
      : "Listening — tap the mic again to stop, then review and click Send.";
  };
  rec.onend = () => {
    state.recognising = false;
    $("mic-btn").classList.remove("recording");
    $("text-answer").classList.remove("listening");
    $("answer-hint").classList.remove("listening");
    setMicLabel("Hold to talk");
    if (state.interimText) {
      state.finalisedFromMic += (state.finalisedFromMic.endsWith(" ") ? "" : " ") + state.interimText;
      state.interimText = "";
      paintAnswer();
    }
    clearSilenceTimer();
    if (!state.awaitingReply && !state.speaking) {
      setState("idle", "Idle — your turn");
      $("answer-hint").textContent = "Review and edit the text, then click Send.";
    }
  };
  rec.onerror = (e) => {
    state.recognising = false;
    $("mic-btn").classList.remove("recording");
    $("text-answer").classList.remove("listening");
    $("answer-hint").classList.remove("listening");
    setMicLabel("Hold to talk");
    clearSilenceTimer();
    setState("idle", "Idle");
    if (e.error === "not-allowed") {
      alert("Microphone permission was denied. Please allow it, or type your answer.");
    } else if (e.error !== "aborted" && e.error !== "no-speech") {
      console.warn("Recognition error:", e.error);
    }
  };
  rec.onresult = (event) => {
    let interim = "";
    let newFinal = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const t = r[0].transcript;
      if (r.isFinal) {
        newFinal += (newFinal.endsWith(" ") ? "" : " ") + t.trim();
      } else {
        interim += " " + t;
      }
    }
    if (newFinal.trim()) {
      state.finalisedFromMic += (state.finalisedFromMic.endsWith(" ") ? "" : " ") + newFinal.trim();
    }
    state.interimText = interim.trim();
    paintAnswer();
    armSilenceTimer();
  };
}

// ---------- API calls ----------
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`${r.status} ${detail}`);
  }
  return r.json();
}

async function startInterview(e) {
  e.preventDefault();
  const topic = $("topic").value.trim();
  if (!topic) return;
  const difficulty = $("difficulty").value;
  const target = parseInt($("target-questions").value, 10) || 6;
  const name = $("candidate-name").value.trim() || null;
  const interviewStyle = $("interview-style").value || "mixed";
  const persona = ($("persona") && $("persona").value) || "hiring-manager";
  const smallTalk = !!($("small-talk") && $("small-talk").checked);
  const targetMinutes = parseInt(($("target-minutes") || {}).value, 10) || 15;

  const mode = ($("mode") && $("mode").value) || "job";
  const studyMaterial = mode === "study" ? ($("study-material").value.trim() || null) : null;

  if (mode === "study" && !studyMaterial) {
    alert("Upload or paste some study material first — that's the source of your questions.");
    return;
  }

  const roleContext = $("role-context").value.trim() || null;
  const focusAreas = $("focus-areas").value.trim() || null;
  const candidateBackground = $("candidate-background").value.trim() || null;
  const scenariosToCover = $("scenarios-to-cover").value.trim() || null;

  const btn = $("start-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="loader"></span><span>Starting…</span>';

  try {
    const data = await postJSON(API.start, {
      topic, difficulty,
      target_questions: target,
      candidate_name: name,
      interview_style: interviewStyle,
      role_context: roleContext,
      focus_areas: focusAreas,
      candidate_background: candidateBackground,
      scenarios_to_cover: scenariosToCover,
      persona,
      small_talk: smallTalk,
      target_minutes: targetMinutes,
      mode,
      study_material: studyMaterial,
      custom_persona_name: persona === "custom" ? ($("custom-persona-name").value.trim() || null) : null,
      custom_persona_prompt: persona === "custom" ? ($("custom-persona-prompt").value.trim() || null) : null,
      adaptive_difficulty: true,
      custom_criteria: (($("custom-criteria") && $("custom-criteria").value.trim()) || "")
        .split(",").map(s => s.trim()).filter(Boolean).slice(0, 8) || null,
      resume_centric: !$("resume-centric") ? true : $("resume-centric").checked,
    });
    state.sessionId = data.session_id;
    state.topic = topic;
    state.difficulty = difficulty;
    state.interviewStyle = interviewStyle;
    state.persona = persona;
    state.panelVoices = {}; // reset for new session

    const styleLabel = interviewStyle === "mixed" ? "" : ` · ${humanStyle(interviewStyle)}`;
    const personaLabel = persona === "panel" ? " · panel" : "";
    $("topic-pill").textContent = `${topic} · ${difficulty}${styleLabel}${personaLabel}`;
    $("question-pill").textContent = `Question 1 of ~${target}`;
    $("transcript").innerHTML = "";
    $("text-answer").value = "";
    clearNotes();
    clearCodeArtifact();
    setSpeaker(persona === "panel" ? (data.speaker || "Mike") : null);
    setAvatarPersona(persona);
    refreshSendBtnState();
    showScreen("interview");
    startClock(targetMinutes);

    appendTurn("interviewer", data.opening_message);
    $("mic-btn").disabled = true;
    const voiceOverride = persona === "panel" ? voiceForSpeaker(data.speaker || "Mike") : undefined;
    await speak(data.opening_message, { voiceOverride });
    $("mic-btn").disabled = false;
    // Warm a few acks AFTER the opening so they don't queue behind real audio.
    // Fire-and-forget — completes in the background while the user thinks.
    warmAcks();
    afterInterviewerSpoke();
  } catch (err) {
    alert("Failed to start interview: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Start interview</span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';
  }
}

function humanStyle(s) {
  return {
    "conversational": "conversational",
    "structured-behavioral": "behavioural",
    "case-study": "case study",
    "technical-deep-dive": "tech deep-dive",
    "mixed": "mixed",
  }[s] || s;
}

// Called whenever the interviewer finishes speaking. If auto-listen is on,
// arm the mic immediately so the user can just start talking.
function afterInterviewerSpoke() {
  if (settings.autoListen && !state.awaitingReply && state.sessionId) {
    // Tiny delay so the UI has time to settle and the user is ready.
    setTimeout(() => {
      if (!state.speaking && !state.recognising && !state.awaitingReply) {
        startListening({ silent: true });
      }
    }, 350);
  } else {
    setState("idle", "Idle — your turn");
  }
}

async function sendAnswer(text) {
  if (!state.sessionId || state.awaitingReply) return;
  if (state.recognising) stopListening();

  // If the code pad has content, attach it as a fenced block on the answer.
  const codePad = $("code-pad");
  const code = codePad && !codePad.classList.contains("hidden") ? codePad.value.trim() : "";
  const fullAnswer = code ? `${text}\n\n\`\`\`\n${code}\n\`\`\`` : text;

  // Determine the index this candidate turn will occupy in the transcript.
  const turnIndex = $("transcript").querySelectorAll(".turn").length;
  appendTurn("candidate", fullAnswer, { turnIndex });

  // Fire-and-forget: upload the captured audio for this turn so we can play
  // it back in the report. Doesn't block the send.
  if (state._lastCandidateAudio && state._lastCandidateAudio.size > 0) {
    const audioBlob = state._lastCandidateAudio;
    state._lastCandidateAudio = null;
    const fd = new FormData();
    fd.append("file", audioBlob, "answer.webm");
    fetch(API.audioSave(state.sessionId, turnIndex), { method: "POST", body: fd }).catch(() => {});
  }

  state.awaitingReply = true;
  setState("thinking", "Thinking…");
  $("mic-btn").disabled = true;
  $("send-text-btn").disabled = true;
  $("text-answer").disabled = true;

  // Fire ack and Claude call in parallel. Ack plays immediately so the user
  // hears something within ~50ms instead of staring at silence for 4-5s.
  const ackPromise = playAck();
  const responseMs = answerResponseMs();
  const claudePromise = postJSON(API.respond(state.sessionId), {
    answer: fullAnswer,
    response_time_ms: responseMs,
  });

  try {
    // Wait for BOTH: the substantive reply waits for the ack to finish so we
    // don't cut off "Got it, let me think..." with the actual answer.
    const [, data] = await Promise.all([ackPromise, claudePromise]);
    appendTurn("interviewer", data.reply);
    $("question-pill").textContent = `Question ${data.turn_number}`;
    // Notes panel updates with the interviewer's private observation.
    if (data.note) appendNote(data.note);
    // Code artifact (if any) appears below the conversation.
    if (data.code_artifact) showCodeArtifact(data.code_artifact);
    // Panel mode: swap voice based on which interviewer is speaking.
    if (state.persona === "panel" && data.speaker) setSpeaker(data.speaker);
    const voiceOverride = state.persona === "panel"
      ? voiceForSpeaker(data.speaker || state.lastSpeaker || "Mike")
      : undefined;
    await speak(data.reply, { voiceOverride });

    if (data.should_finish) {
      setState("idle", "Interview complete");
      await finishInterview();
    } else {
      // Re-enable input first, then trigger auto-listen
      state.awaitingReply = false;
      $("mic-btn").disabled = false;
      $("text-answer").disabled = false;
      $("text-answer").value = "";
      state.finalisedFromMic = "";
      state.finalisedTextBeforeMic = "";
      state.interimText = "";
      refreshSendBtnState();
      afterInterviewerSpoke();
      markAnswerStart();
      return;
    }
  } catch (err) {
    alert("Error: " + err.message);
    setState("idle", "Error");
  } finally {
    state.awaitingReply = false;
    $("mic-btn").disabled = false;
    $("text-answer").disabled = false;
    // Clear the code pad too if the user used it.
    const cp = $("code-pad");
    if (cp && !cp.classList.contains("hidden")) cp.value = "";
    refreshSendBtnState();
  }
}

async function finishInterview() {
  if (!state.sessionId) return;
  $("finish-btn").disabled = true;
  setState("thinking", "Evaluating…");
  try {
    const data = await postJSON(API.finish(state.sessionId));
    state.currentReport = data.report;
    pushHistory(data.report);
    renderReport(data.report);
    showScreen("report");
  } catch (err) {
    alert("Evaluation failed: " + err.message);
    setState("idle", "Idle");
  } finally {
    $("finish-btn").disabled = false;
    stopClock();
  }
}

// ---------- Report rendering ----------
function verdictClass(v) { return "verdict-" + v.toLowerCase().replace(/\s+/g, "-"); }

function renderReport(report) {
  const el = $("report-content");
  el.innerHTML = "";

  const header = document.createElement("div");
  header.className = "report-header";
  const verdict = document.createElement("span");
  verdict.className = "report-verdict " + verdictClass(report.verdict);
  verdict.textContent = report.verdict;
  header.appendChild(verdict);
  const score = document.createElement("div");
  score.className = "score-big";
  score.innerHTML = `${report.overall_score}<span class="score-denom"> / 10</span>`;
  header.appendChild(score);
  const meta = document.createElement("div");
  meta.className = "report-meta";
  meta.textContent = `${report.topic} · ${report.difficulty}${report.candidate_name ? " · " + report.candidate_name : ""}`;
  header.appendChild(meta);
  el.appendChild(header);

  if (report.summary) {
    const summary = document.createElement("p");
    summary.className = "report-summary";
    summary.textContent = report.summary;
    el.appendChild(summary);
  }

  const critWrap = document.createElement("div");
  critWrap.className = "criteria-list";
  report.criteria.forEach((c) => {
    const pct = Math.max(0, Math.min(100, c.score * 10));
    const row = document.createElement("div");
    row.className = "criterion";
    row.innerHTML = `
      <div class="criterion-name">${escapeHTML(c.name)}</div>
      <div class="criterion-rationale">${escapeHTML(c.rationale)}</div>
      <div class="criterion-score">
        <span class="num">${c.score}<span style="font-size:13px;color:var(--text-muted);font-weight:500;-webkit-text-fill-color:var(--text-muted);"> /10</span></span>
        <div class="score-bar"><div class="score-bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
    critWrap.appendChild(row);
  });
  el.appendChild(critWrap);

  if (report.strengths && report.strengths.length) {
    const sec = document.createElement("div");
    sec.className = "report-section";
    sec.innerHTML = `<h3>Strengths</h3><ul class="tag-list strengths">${report.strengths.map(s => `<li>${escapeHTML(s)}</li>`).join("")}</ul>`;
    el.appendChild(sec);
  }

  if (report.gaps && report.gaps.length) {
    const sec = document.createElement("div");
    sec.className = "report-section";
    sec.innerHTML = `<h3>Gaps &amp; growth areas</h3><ul class="tag-list gaps">${report.gaps.map(s => `<li>${escapeHTML(s)}</li>`).join("")}</ul>`;
    el.appendChild(sec);
  }

  if (report.question_solutions && report.question_solutions.length) {
    const sec = document.createElement("div");
    sec.className = "report-section";
    const items = report.question_solutions.map((q, i) => {
      const candidate = q.candidate_answer && q.candidate_answer.trim() ? q.candidate_answer : "No answer given.";
      const feedback = q.feedback && q.feedback.trim()
        ? `<div class="solution-feedback"><span class="solution-feedback-label">Where you stood</span> ${escapeHTML(q.feedback)}</div>`
        : "";
      return `
        <details class="solution" ${i === 0 ? "open" : ""}>
          <summary>
            <span class="solution-num">Q${i + 1}</span>
            <span class="solution-question">${escapeHTML(q.question)}</span>
            <span class="solution-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
          </summary>
          <div class="solution-body">
            <div class="solution-block solution-yours">
              <div class="solution-block-label">Your answer</div>
              <div class="solution-block-text">${escapeHTML(candidate)}</div>
            </div>
            <div class="solution-block solution-model">
              <div class="solution-block-label">Model answer</div>
              <div class="solution-block-text">${escapeHTML(q.model_answer)}</div>
            </div>
            ${feedback}
          </div>
        </details>
      `;
    }).join("");
    sec.innerHTML = `
      <h3>Model answers <span class="report-section-sub">— how a strong candidate would have answered each question</span></h3>
      <div class="solutions-list">${items}</div>
    `;
    el.appendChild(sec);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Report → Markdown export ----------
function _mdQuote(text) {
  // Render text as a > blockquote, line by line.
  return String(text || "").trim().split("\n").map(l => "> " + l).join("\n");
}

function buildReportMarkdown(report) {
  const date = new Date().toLocaleString();
  const lines = [];
  lines.push(`# Interview Report`);
  lines.push("");
  lines.push(`- **Topic:** ${report.topic || ""}`);
  lines.push(`- **Difficulty:** ${report.difficulty || ""}`);
  if (report.candidate_name) lines.push(`- **Candidate:** ${report.candidate_name}`);
  lines.push(`- **Generated:** ${date}`);
  lines.push("");
  lines.push(`## Overall Score: ${report.overall_score}/10  —  ${report.verdict}`);
  lines.push("");
  if (report.summary) {
    lines.push(report.summary);
    lines.push("");
  }

  if (Array.isArray(report.criteria) && report.criteria.length) {
    lines.push("## Criteria");
    lines.push("");
    lines.push("| Criterion | Score | Notes |");
    lines.push("|---|---|---|");
    for (const c of report.criteria) {
      const rationale = (c.rationale || "").replace(/\|/g, "\\|");
      lines.push(`| ${c.name} | ${c.score}/10 | ${rationale} |`);
    }
    lines.push("");
  }

  if (Array.isArray(report.strengths) && report.strengths.length) {
    lines.push("## Strengths");
    lines.push("");
    for (const s of report.strengths) lines.push(`- ${s}`);
    lines.push("");
  }

  if (Array.isArray(report.gaps) && report.gaps.length) {
    lines.push("## Gaps & growth areas");
    lines.push("");
    for (const g of report.gaps) lines.push(`- ${g}`);
    lines.push("");
  }

  // Questions + model answers
  if (Array.isArray(report.question_solutions) && report.question_solutions.length) {
    lines.push("## Questions and model answers");
    lines.push("");
    report.question_solutions.forEach((q, i) => {
      lines.push(`### Q${i + 1}. ${q.question || ""}`);
      lines.push("");
      lines.push(`**Your answer:**`);
      lines.push("");
      lines.push(_mdQuote(q.candidate_answer || "*(no answer given)*"));
      lines.push("");
      lines.push(`**Model answer:**`);
      lines.push("");
      lines.push(q.model_answer || "");
      lines.push("");
      if (q.feedback) {
        lines.push(`**Where you stood:** ${q.feedback}`);
        lines.push("");
      }
      lines.push("---");
      lines.push("");
    });
  }

  // Full transcript at the bottom
  if (Array.isArray(report.transcript) && report.transcript.length) {
    lines.push("## Full transcript");
    lines.push("");
    for (const t of report.transcript) {
      const who = t.role === "interviewer" ? "**Interviewer**" : "**You**";
      lines.push(`${who}: ${t.content}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildQAMarkdown(report) {
  // Compact study sheet — just questions + model answers.
  const lines = [];
  lines.push(`# Q&A — ${report.topic || "Interview"}`);
  lines.push("");
  lines.push(`*${report.difficulty || ""}${report.candidate_name ? " · " + report.candidate_name : ""} · ${new Date().toLocaleDateString()}*`);
  lines.push("");
  if (!Array.isArray(report.question_solutions) || !report.question_solutions.length) {
    lines.push("_(No question/answer pairs were captured for this session.)_");
    return lines.join("\n");
  }
  report.question_solutions.forEach((q, i) => {
    lines.push(`## Q${i + 1}. ${q.question || ""}`);
    lines.push("");
    lines.push(`**Your answer:**`);
    lines.push("");
    lines.push(_mdQuote(q.candidate_answer || "*(no answer given)*"));
    lines.push("");
    lines.push(`**Model answer:**`);
    lines.push("");
    lines.push(q.model_answer || "");
    lines.push("");
    if (q.feedback) {
      lines.push(`> _${q.feedback}_`);
      lines.push("");
    }
  });
  return lines.join("\n");
}

function _safeFilename(s) {
  return String(s || "interview")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "interview";
}

function downloadText(text, filename, mime = "text/markdown;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  triggerDownload(blob, filename);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Backend-generated Word .docx of the report.
async function downloadDocx(report, format, btn) {
  if (!report) return;
  const origLabel = btn ? btn.querySelector("span").textContent : null;
  try {
    if (btn) {
      btn.disabled = true;
      btn.querySelector("span").textContent = "Generating…";
    }
    const r = await fetch("/api/report/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report, format }),
    });
    if (!r.ok) {
      let detail = r.statusText;
      try { const j = await r.json(); detail = j.detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    const blob = await r.blob();
    const stem = format === "qa" ? "vox-qa" : "vox-report";
    const topic = _safeFilename(report.topic);
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `${stem}-${topic}-${date}.docx`);
  } catch (e) {
    alert("Download failed: " + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.querySelector("span").textContent = origLabel;
    }
  }
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.querySelector("span").textContent;
      btn.querySelector("span").textContent = "Copied!";
      setTimeout(() => { btn.querySelector("span").textContent = orig; }, 1200);
    }
  } catch (e) {
    alert("Couldn't copy to clipboard: " + e.message);
  }
}

// ---------- Setup-screen interactions ----------
function wireSegmented(segId, hiddenId) {
  document.querySelectorAll(`#${segId} .seg-opt`).forEach((opt) => {
    opt.addEventListener("click", () => {
      document.querySelectorAll(`#${segId} .seg-opt`).forEach((o) => {
        o.classList.remove("active");
        o.setAttribute("aria-checked", "false");
      });
      opt.classList.add("active");
      opt.setAttribute("aria-checked", "true");
      // Special-case: persona segment has a "__custom__" sentinel
      if (segId === "persona-seg") {
        applyCustomPersonaUI(opt.dataset.value);
      } else {
        $(hiddenId).value = opt.dataset.value;
      }
    });
  });
}

// ---------- Templates (save/load interview-context presets) ----------
const TEMPLATES_KEY = "vox.templates.v1";

function loadTemplates() {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || "{}");
  } catch (_) {
    return {};
  }
}
function saveTemplatesObj(obj) {
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(obj));
    return true;
  } catch (e) {
    console.error("Failed to save templates:", e);
    alert("Could not save template to localStorage: " + e.message +
          "\n\nThis usually means your browser's storage quota is full or " +
          "your browser is in private/incognito mode.");
    return false;
  }
}

function captureFormState() {
  return {
    candidate_name: $("candidate-name").value,
    topic: $("topic").value,
    difficulty: $("difficulty").value,
    target_questions: $("target-questions").value,
    role_context: $("role-context").value,
    focus_areas: $("focus-areas").value,
    candidate_background: $("candidate-background").value,
    scenarios_to_cover: $("scenarios-to-cover").value,
    interview_style: $("interview-style").value,
    persona: ($("persona") || {}).value || "hiring-manager",
    small_talk: !!($("small-talk") && $("small-talk").checked),
    target_minutes: ($("target-minutes") || {}).value || 15,
  };
}

function applyFormState(s) {
  $("candidate-name").value = s.candidate_name || "";
  $("topic").value = s.topic || "";
  $("target-questions").value = s.target_questions || 6;
  $("role-context").value = s.role_context || "";
  $("focus-areas").value = s.focus_areas || "";
  $("candidate-background").value = s.candidate_background || "";
  $("scenarios-to-cover").value = s.scenarios_to_cover || "";
  if ($("target-minutes")) $("target-minutes").value = s.target_minutes || 15;
  if ($("small-talk")) $("small-talk").checked = !!s.small_talk;

  const diff = s.difficulty || "intermediate";
  const diffBtn = document.querySelector(`#difficulty-seg .seg-opt[data-value="${diff}"]`);
  if (diffBtn) diffBtn.click();

  const style = s.interview_style || "mixed";
  const styleBtn = document.querySelector(`#style-seg .seg-opt[data-value="${style}"]`);
  if (styleBtn) styleBtn.click();

  const persona = s.persona || "hiring-manager";
  const personaBtn = document.querySelector(`#persona-seg .seg-opt[data-value="${persona}"]`);
  if (personaBtn) personaBtn.click();

  const hasCtx = s.role_context || s.focus_areas || s.candidate_background || s.scenarios_to_cover || s.persona !== "hiring-manager" || s.small_talk;
  const panel = $("context-panel");
  if (panel) panel.open = !!hasCtx || panel.open;
}

function refreshTemplatePicker(selectName) {
  const sel = $("template-picker");
  if (!sel) return;
  const templates = loadTemplates();
  const names = Object.keys(templates).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">— Load a saved template —</option>';
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === selectName) opt.selected = true;
    sel.appendChild(opt);
  }
  $("delete-template-btn").disabled = !sel.value;
  // Show the empty-state hint only when there really are no templates.
  const hint = $("template-hint");
  if (hint) hint.classList.toggle("hidden", names.length > 0);
}

function wireTemplates() {
  const picker = $("template-picker");
  if (!picker) return;

  refreshTemplatePicker();

  picker.addEventListener("change", () => {
    const name = picker.value;
    $("delete-template-btn").disabled = !name;
    if (!name) return;
    const templates = loadTemplates();
    const t = templates[name];
    if (t) applyFormState(t);
  });

  $("save-template-btn").addEventListener("click", () => {
    if (!$("topic").value.trim()) {
      alert("Enter a topic before saving a template.");
      $("topic").focus();
      return;
    }
    const cur = picker.value;
    const promptLabel = cur
      ? `Update template "${cur}" — keep the name to overwrite, or change it to save as a new template:`
      : "Name this template (e.g. 'Senior PM — Fintech'):";
    const name = (prompt(promptLabel, cur || $("topic").value.trim()) || "").trim();
    if (!name) return;

    const templates = loadTemplates();
    const exists = !!templates[name] && name !== cur;
    if (exists && !confirm(`A template named "${name}" already exists. Overwrite it?`)) return;

    templates[name] = { ...captureFormState(), _savedAt: new Date().toISOString() };
    if (saveTemplatesObj(templates)) {
      refreshTemplatePicker(name);
    }
  });

  $("delete-template-btn").addEventListener("click", () => {
    const name = picker.value;
    if (!name) return;
    if (!confirm(`Delete template "${name}"? This can't be undone.`)) return;
    const templates = loadTemplates();
    delete templates[name];
    saveTemplatesObj(templates);
    refreshTemplatePicker();
  });
}

// ---------- Resume in-progress sessions (pause/resume) ----------
async function checkForResumableSession() {
  try {
    const r = await fetch(API.sessions("in_progress"));
    if (!r.ok) return;
    const data = await r.json();
    const sessions = data.sessions || [];
    if (!sessions.length) return;
    const s = sessions[0]; // most recent
    const strip = $("resume-strip");
    if (!strip) return;
    $("resume-strip-title").textContent = `Resume: ${s.topic || "Untitled interview"}`;
    const when = new Date(s.updated_at * 1000).toLocaleString();
    $("resume-strip-sub").textContent = `Started ${when} · ${s.mode === "study" ? "Study" : "Job"} mode`;
    strip.classList.remove("hidden");
    $("resume-strip-btn").onclick = () => resumeSession(s.id);
    $("resume-strip-dismiss").onclick = () => strip.classList.add("hidden");
  } catch (_) {}
}

async function resumeSession(sessionId) {
  try {
    const r = await fetch(API.resume(sessionId));
    if (!r.ok) throw new Error("Could not load session");
    const s = await r.json();

    state.sessionId = s.id;
    state.topic = s.topic;
    state.difficulty = s.difficulty;
    state.interviewStyle = s.interview_style;
    state.persona = s.persona;
    state.lastSpeaker = s.last_speaker;

    $("topic-pill").textContent = `${s.topic} · ${s.difficulty}`;
    $("question-pill").textContent = `Resumed at Q${s.primary_questions_asked}`;
    setAvatarPersona(s.persona);
    if (s.persona === "panel" && s.last_speaker) setSpeaker(s.last_speaker);
    else setSpeaker(null);

    // Repaint transcript with audio playback buttons
    $("transcript").innerHTML = "";
    clearNotes();
    clearCodeArtifact();
    let candidateIdx = 0;
    s.turns.forEach((t, i) => {
      const turnIndex = i; // matches the index used when audio was saved
      appendTurn(t.role, t.content, { turnIndex: t.role === "candidate" ? turnIndex : null });
    });
    // Re-show notes
    for (const n of (s.notes || [])) appendNote(n);

    // If session is already finished and has a report, just show the report.
    if (s.finished && s.report) {
      state.currentReport = s.report;
      renderReport(s.report);
      showScreen("report");
      return;
    }

    showScreen("interview");
    startClock(s.target_minutes || 15);
    setState("idle", "Resumed — your turn");
    $("answer-hint").textContent = "Resumed mid-interview. Hold the mic to continue.";
  } catch (e) {
    alert("Could not resume: " + e.message);
  }
}

// ---------- Spaced repetition (weak spots) ----------
async function checkForWeakSpots() {
  try {
    const r = await fetch(API.weakSpots);
    if (!r.ok) return;
    const data = await r.json();
    const gaps = data.gaps || [];
    if (gaps.length < 3) return; // need enough data to be useful
    const strip = $("weak-spots-strip");
    if (!strip) return;
    const top = gaps.slice(0, 3).map(g => g.gap.split(/[.,;]/)[0].slice(0, 60));
    $("weak-spots-sub").textContent = top.join(" · ");
    strip.classList.remove("hidden");
    $("weak-spots-btn").onclick = () => fillWeakSpotsForm(gaps);
  } catch (_) {}
}

function fillWeakSpotsForm(gaps) {
  // Pull together a focused-areas prompt and a topic line.
  const topPhrases = gaps.slice(0, 6).map(g => g.gap.split(/[.,;]/)[0].trim()).join("; ");
  $("topic").value = "Weak-spots review — focused mini-session";
  $("focus-areas").value = topPhrases;
  $("target-questions").value = "5";
  $("target-minutes").value = "10";
  // Open context panel so user can see what was filled
  const panel = $("context-panel");
  if (panel) panel.open = true;
  // Scroll to the start button
  $("start-btn").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- Custom personas ----------
function applyCustomPersonaUI(selectedValue) {
  const row = $("custom-persona-row");
  if (!row) return;
  if (selectedValue === "__custom__") {
    row.classList.remove("hidden");
    $("persona").value = "custom";
  } else {
    row.classList.add("hidden");
    $("persona").value = selectedValue;
  }
}

// ---------- Progress dashboard ----------
function renderProgress(historyItems) {
  const card = $("progress-card");
  if (!card) return;
  if (!historyItems.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const scores = historyItems.map(h => h.overall_score).filter(s => typeof s === "number");
  const sessions = historyItems.length;
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const best = scores.length ? Math.max(...scores) : 0;
  // Trend: last 5 mean minus previous 5 mean
  const last5 = scores.slice(0, 5);
  const prev5 = scores.slice(5, 10);
  const mean = (xs) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
  const delta = last5.length && prev5.length ? mean(last5) - mean(prev5) : 0;
  const trendStr = !prev5.length ? "—"
    : delta > 0.3 ? `↑ +${delta.toFixed(1)}`
    : delta < -0.3 ? `↓ ${delta.toFixed(1)}`
    : "→ flat";

  $("progress-sessions").textContent = sessions;
  $("progress-avg").textContent = avg.toFixed(1);
  $("progress-best").textContent = best;
  $("progress-trend").textContent = trendStr;
  $("progress-sub").textContent = `${sessions} session${sessions === 1 ? "" : "s"} tracked`;

  // Sparkline (last up-to-20, oldest first)
  const series = scores.slice(0, 20).reverse();
  const spark = $("progress-spark");
  if (spark && series.length >= 2) {
    const W = 400, H = 60, P = 6;
    const dx = (W - 2 * P) / (series.length - 1);
    const max = 10, min = 0;
    const yFor = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
    const pts = series.map((v, i) => `${P + i * dx},${yFor(v)}`);
    const path = "M " + pts.join(" L ");
    const last = pts[pts.length - 1].split(",");
    spark.innerHTML = `<path d="${path}"/><circle cx="${last[0]}" cy="${last[1]}" r="3"/>`;
  } else if (spark) {
    spark.innerHTML = "";
  }

  // Aggregate gaps as chips (use loadHistory full reports)
  const gapCounts = {};
  for (const h of historyItems) {
    const gaps = h.report && h.report.gaps;
    if (!Array.isArray(gaps)) continue;
    for (const g of gaps) {
      const key = g.toLowerCase().split(/[.,;]/)[0].trim().slice(0, 60);
      gapCounts[key] = (gapCounts[key] || 0) + 1;
    }
  }
  const sortedGaps = Object.entries(gapCounts)
    .filter(([_, c]) => c >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const gapsEl = $("progress-gaps");
  if (gapsEl) {
    gapsEl.innerHTML = sortedGaps.length
      ? sortedGaps.map(([g, c]) =>
          `<span class="progress-gap-chip">${escapeHTML(g)}<span class="count">×${c}</span></span>`).join("")
      : '';
  }
}

// ---------- Code-pad toggle (attach code to your answer) ----------
function wireCodePad() {
  const btn = $("toggle-code-pad-btn");
  const pad = $("code-pad");
  const label = $("toggle-code-pad-label");
  if (!btn || !pad) return;
  btn.addEventListener("click", () => {
    const showing = !pad.classList.toggle("hidden");
    btn.classList.toggle("active", showing);
    if (label) label.textContent = showing ? "Hide code" : "Add code";
    if (showing) pad.focus();
  });
}

// ---------- Mode tabs (Job interview vs Study mode) ----------
function applyMode(mode) {
  const form = $("setup-form");
  if (!form) return;
  $("mode").value = mode;
  form.classList.toggle("study-mode", mode === "study");

  // Update tab UI
  document.querySelectorAll(".mode-tab").forEach((t) => {
    const active = t.dataset.mode === mode;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
  });

  // Toggle study panel visibility
  const sp = $("study-panel");
  if (sp) sp.classList.toggle("hidden", mode !== "study");

  // In study mode, hide irrelevant job-only fields inside the context panel.
  const fieldsToHideInStudy = [
    "role-context",
    "candidate-background",
    "scenarios-to-cover",
    "persona-seg",
    "small-talk",
  ];
  for (const id of fieldsToHideInStudy) {
    const el = $(id);
    if (!el) continue;
    // Walk up to the nearest .field container so we hide the whole row.
    const wrap = el.closest(".field") || el.closest(".field-row") || el.parentElement;
    if (wrap) wrap.style.display = (mode === "study") ? "none" : "";
  }
  // Resume upload row → only useful in job mode
  const resumeRow = document.querySelector(".resume-upload");
  if (resumeRow) resumeRow.style.display = (mode === "study") ? "none" : "";

  // Update hero copy + main button
  const heroTitle = document.querySelector("#setup-screen .hero-title");
  const heroSub = document.querySelector("#setup-screen .hero-sub");
  const startBtn = $("start-btn");
  if (mode === "study") {
    if (heroTitle) heroTitle.innerHTML = 'Quiz yourself on <em>anything</em><br/>you\'ve <span class="grad-text">learned.</span>';
    if (heroSub) heroSub.textContent = "Upload your notes, a chapter, or a paper. The coach will quiz you out loud and tell you where your understanding has gaps.";
    if (startBtn) startBtn.querySelector("span").textContent = "Start quiz";
    // Topic label tweak
    const topicLabel = document.querySelector('label[for] .field-label, .field-label');
    // simpler: just update the topic placeholder
    const topicInput = $("topic");
    if (topicInput) topicInput.placeholder = "e.g. Chapter 4 — TCP congestion control";
  } else {
    if (heroTitle) heroTitle.innerHTML = 'Practice <em>spoken</em> interviews<br/>on <span class="grad-text">anything.</span>';
    if (heroSub) heroSub.textContent = "Pick a topic, set the bar, and have a real back-and-forth with an AI interviewer. Get scored on five dimensions when you're done.";
    if (startBtn) startBtn.querySelector("span").textContent = "Start interview";
    const topicInput = $("topic");
    if (topicInput) topicInput.placeholder = "e.g. Python backend, Distributed systems, Behavioural — leadership";
  }
}

function wireModeTabs() {
  document.querySelectorAll(".mode-tab").forEach((t) => {
    t.addEventListener("click", () => applyMode(t.dataset.mode));
  });
}

// ---------- Study material upload ----------
function wireMaterialUpload() {
  const fileInput = $("material-file");
  const status = $("material-status");
  const textarea = $("study-material");
  if (!fileInput || !status || !textarea) return;

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    status.textContent = `Reading ${file.name}…`;
    status.className = "resume-status loading";

    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/material/extract", { method: "POST", body: fd });
      if (!r.ok) {
        let detail = r.statusText;
        try { const j = await r.json(); detail = j.detail || detail; } catch (_) {}
        throw new Error(detail);
      }
      const data = await r.json();
      textarea.value = data.text || "";
      const wc = (data.word_count || 0).toLocaleString();
      const tag = data.truncated ? ` (truncated to ${(data.char_count/1000).toFixed(0)}k chars)` : "";
      status.textContent = `✓ Loaded ${wc} words from ${file.name}${tag}`;
      status.className = "resume-status ok";
    } catch (err) {
      console.error("Material upload failed:", err);
      status.textContent = "Couldn't read — " + (err.message || "try a different file");
      status.className = "resume-status error";
    } finally {
      fileInput.value = "";
    }
  });

  // Manual paste — show a friendly count
  textarea.addEventListener("input", () => {
    const wc = textarea.value.trim().split(/\s+/).filter(Boolean).length;
    if (wc > 0) {
      status.textContent = `${wc.toLocaleString()} words pasted`;
      status.className = "resume-status ok";
    } else {
      status.textContent = "";
      status.className = "resume-status";
    }
  });
}

// ---------- Resume upload (auto-fills background + suggestions) ----------
function wireResumeUpload() {
  const fileInput = $("resume-file");
  const status = $("resume-status");
  if (!fileInput || !status) return;

  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    status.textContent = `Reading ${file.name}…`;
    status.className = "resume-status loading";

    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/resume/parse", { method: "POST", body: fd });
      if (!r.ok) {
        let detail = r.statusText;
        try { const j = await r.json(); detail = j.detail || detail; } catch (_) {}
        throw new Error(detail);
      }
      const data = await r.json();

      // Auto-fill, but DON'T overwrite anything the user already typed.
      const overwriteEmpty = (id, value) => {
        const el = $(id);
        if (el && value && !el.value.trim()) el.value = value;
      };
      // Background gets overwritten because the upload is the user's signal
      // they want this content; they can edit before sending.
      if (data.background) $("candidate-background").value = data.background;
      overwriteEmpty("candidate-name", data.name);
      overwriteEmpty("role-context", data.role_context_suggestion);
      overwriteEmpty("focus-areas", data.focus_areas_suggestion);
      overwriteEmpty("topic", data.topic_suggestion);

      // Open the context panel so the user can see the auto-filled fields
      const panel = $("context-panel");
      if (panel) panel.open = true;

      const headline = data.headline || "profile loaded";
      status.textContent = `✓ ${headline}`;
      status.className = "resume-status ok";
    } catch (err) {
      console.error("Resume upload failed:", err);
      status.textContent = "Couldn't parse — " + (err.message || "try a different file");
      status.className = "resume-status error";
    } finally {
      // Allow re-upload of the same file
      fileInput.value = "";
    }
  });
}

function wireSetupControls() {
  document.querySelectorAll(".chip[data-topic]").forEach((c) => {
    c.addEventListener("click", () => {
      $("topic").value = c.dataset.topic;
      $("topic").focus();
    });
  });
  document.querySelectorAll(".chip[data-add-focus]").forEach((c) => {
    c.addEventListener("click", () => {
      const ta = $("focus-areas");
      const v = ta.value.trim();
      const phrase = c.dataset.addFocus;
      if (v.toLowerCase().includes(phrase.toLowerCase())) return;
      ta.value = v ? `${v}, ${phrase}` : phrase;
    });
  });
  wireSegmented("difficulty-seg", "difficulty");
  wireSegmented("style-seg", "interview-style");
  wireSegmented("persona-seg", "persona");
  document.querySelectorAll(".step-btn").forEach((b) => {
    b.addEventListener("click", () => {
      // The target input is either the target-questions stepper or any other
      // stepper that sets data-target on the button.
      const target = b.dataset.target || "target-questions";
      const input = $(target);
      if (!input) return;
      const min = parseInt(input.min, 10) || 1;
      const max = parseInt(input.max, 10) || 999;
      const cur = parseInt(input.value, 10) || min;
      const step = parseInt(b.dataset.step, 10);
      input.value = Math.max(min, Math.min(max, cur + step));
    });
  });
}

// ---------- Settings panel ----------
function wireSettingsPanel() {
  const btn = $("settings-btn");
  const panel = $("settings-panel");
  if (!btn || !panel) return;

  const open = () => { panel.classList.remove("hidden"); btn.classList.add("open"); };
  const close = () => { panel.classList.add("hidden"); btn.classList.remove("open"); };

  btn.addEventListener("click", () => {
    if (panel.classList.contains("hidden")) open();
    else close();
  });
  $("close-settings-btn").addEventListener("click", close);

  // Voice picker
  $("voice-picker").addEventListener("change", (e) => {
    settings.voiceName = e.target.value;
    // For Web Speech fallback also update the browser voice ref.
    if (!state.backendTTSAvailable) {
      state.preferredVoice = state.voices.find(v => v.name === settings.voiceName) || state.preferredVoice;
    }
    updateVoiceTip();
    saveSettings();
  });

  // Rate slider
  const rateSlider = $("rate-slider");
  rateSlider.value = settings.rate;
  $("rate-value").textContent = `${settings.rate.toFixed(2)}×`;
  rateSlider.addEventListener("input", (e) => {
    settings.rate = parseFloat(e.target.value);
    $("rate-value").textContent = `${settings.rate.toFixed(2)}×`;
    saveSettings();
  });

  // Toggles
  const autoListen = $("auto-listen-toggle");
  autoListen.checked = settings.autoListen;
  autoListen.addEventListener("change", (e) => {
    settings.autoListen = e.target.checked;
    saveSettings();
  });

  const autoSend = $("auto-send-toggle");
  autoSend.checked = settings.autoSendOnSilence;
  autoSend.addEventListener("change", (e) => {
    settings.autoSendOnSilence = e.target.checked;
    saveSettings();
  });

  const silenceSecs = $("silence-secs");
  silenceSecs.value = settings.silenceSeconds;
  silenceSecs.addEventListener("change", (e) => {
    const n = parseFloat(e.target.value);
    if (!isNaN(n) && n >= 0.3 && n <= 3) {
      settings.silenceSeconds = n;
      saveSettings();
    }
  });

  const acks = $("acks-toggle");
  acks.checked = settings.acknowledgements;
  acks.addEventListener("change", (e) => {
    settings.acknowledgements = e.target.checked;
    saveSettings();
  });

  // Test voice
  $("test-voice-btn").addEventListener("click", async () => {
    cancelSpeech();
    await speak("Hi there. This is how I'll sound during the interview. Let me know if you'd like a different voice or speed.");
  });
}

// ---------- Mic button: hold-to-talk + click-to-toggle + interrupt ----------
function wireMicButton() {
  const mic = $("mic-btn");
  let pressed = false;
  let pressStart = 0;
  let toggled = false;

  const press = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (state.speaking) cancelSpeech();
    if (state.recognising) {
      // Already listening (auto-listen). Stop on tap.
      stopListening();
      toggled = false;
      return;
    }
    pressed = true;
    pressStart = Date.now();
    toggled = false;
    startListening();
  };
  const release = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!pressed) return;
    pressed = false;
    const heldFor = Date.now() - pressStart;
    // If user just tapped briefly (<280ms), treat as toggle — leave listening on
    if (heldFor < 280) {
      toggled = true;
      return;
    }
    stopListening();
  };

  mic.addEventListener("mousedown", press);
  mic.addEventListener("mouseup", release);
  mic.addEventListener("mouseleave", (e) => { if (pressed) release(e); });
  mic.addEventListener("touchstart", press, { passive: false });
  mic.addEventListener("touchend", release, { passive: false });
}

// ---------- Question packs (preset templates) ----------
let _packsCache = [];
async function loadQuestionPacks() {
  try {
    const r = await fetch(API.packs);
    if (!r.ok) return;
    _packsCache = (await r.json()).packs || [];
    const sel = $("packs-picker");
    if (!sel) return;
    sel.innerHTML = '<option value="">— Or pick a preset —</option>';
    for (const p of _packsCache) {
      const opt = document.createElement("option");
      opt.value = p.id; opt.textContent = p.name;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const pack = _packsCache.find(p => p.id === sel.value);
      if (!pack) return;
      $("topic").value = pack.topic || "";
      $("target-questions").value = pack.target_questions || 6;
      $("target-minutes").value = pack.target_minutes || 15;
      $("focus-areas").value = pack.focus_areas || "";
      const diffBtn = document.querySelector(`#difficulty-seg .seg-opt[data-value="${pack.difficulty}"]`);
      if (diffBtn) diffBtn.click();
      const styleBtn = document.querySelector(`#style-seg .seg-opt[data-value="${pack.interview_style}"]`);
      if (styleBtn) styleBtn.click();
      const personaBtn = document.querySelector(`#persona-seg .seg-opt[data-value="${pack.persona}"]`);
      if (personaBtn) personaBtn.click();
      const panel = $("context-panel");
      if (panel) panel.open = true;
      sel.value = "";
    });
  } catch (_) {}
}

// ---------- Email report (mailto:) ----------
function emailReport() {
  const r = state.currentReport;
  if (!r) return;
  const subject = `Vox interview report — ${r.topic} (${r.overall_score}/10 ${r.verdict})`;
  const body = buildReportMarkdown(r);
  // mailto bodies are capped (~2000 chars by most clients); truncate
  const trimmed = body.length > 1800 ? body.slice(0, 1800) + "\n\n[…truncated; download the full .docx]" : body;
  const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(trimmed)}`;
  window.location.href = url;
}

// ---------- Shareable read-only reports ----------
async function shareReport() {
  if (!state.sessionId) {
    alert("Open a finished report (from History) first.");
    return;
  }
  try {
    const r = await fetch(API.share(state.sessionId), { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const url = `${window.location.origin}/share/${data.token}`;
    await navigator.clipboard.writeText(url);
    alert(`Share link copied to clipboard:\n\n${url}\n\nAnyone with this link can view the report and leave comments.`);
  } catch (e) {
    alert("Couldn't generate share link: " + e.message);
  }
}

// Read-only share view — entered when URL is /share/{token}
async function openShareView() {
  const match = location.pathname.match(/^\/share\/([^\/]+)$/);
  if (!match) return false;
  const token = match[1];
  try {
    const r = await fetch(API.shareGet(token));
    if (!r.ok) throw new Error("Share not found");
    const data = await r.json();
    if (!data.report) throw new Error("This session hasn't been evaluated yet");

    // Hide setup-only controls
    document.querySelectorAll(".app-nav button").forEach((b) => b.style.display = "none");
    state.currentReport = data.report;
    renderReport(data.report);

    // Append a comment thread
    const reportContent = $("report-content");
    const section = document.createElement("div");
    section.className = "comments-section";
    section.innerHTML = `
      <h3>Mentor comments</h3>
      <div id="comments-list"></div>
      <form id="comment-form" class="comment-form">
        <input type="text" id="comment-author" placeholder="Your name (optional)" maxlength="80" />
        <textarea id="comment-body" rows="3" placeholder="Add a comment…" required></textarea>
        <button type="submit" class="btn-primary btn-sm">Post comment</button>
      </form>
    `;
    reportContent.appendChild(section);
    renderShareComments(data.comments || []);

    section.querySelector("#comment-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = $("comment-body").value.trim();
      if (!body) return;
      const author = $("comment-author").value.trim() || null;
      const r = await fetch(API.shareComments(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, author }),
      });
      if (r.ok) {
        $("comment-body").value = "";
        const updated = await fetch(`${API.shareComments(token)}`).then(r => r.json());
        renderShareComments(updated.comments || []);
      }
    });

    // Hide the action buttons that don't make sense in share mode
    ["new-interview-btn", "share-report-btn", "email-report-btn"].forEach(id => {
      const el = $(id); if (el) el.style.display = "none";
    });

    showScreen("report");
    return true;
  } catch (e) {
    document.body.innerHTML = `<div style="padding:48px;text-align:center;color:#aaa">Could not load shared report: ${e.message}</div>`;
    return true;
  }
}

function renderShareComments(comments) {
  const list = $("comments-list");
  if (!list) return;
  list.innerHTML = comments.length
    ? comments.map(c => {
        const when = new Date(c.created_at * 1000).toLocaleString();
        return `<div class="comment">
          <div class="comment-meta">${escapeHTML(c.author || "Anonymous")} · ${when}</div>
          <div>${escapeHTML(c.body)}</div>
        </div>`;
      }).join("")
    : '<div style="color:var(--text-muted);font-size:13px;font-style:italic;">No comments yet — be the first.</div>';
}

// ---------- History search ----------
let _historyAllItems = [];
function wireHistorySearch() {
  const input = $("history-search");
  if (!input) return;
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll(".history-item").forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = (!q || text.includes(q)) ? "" : "none";
    });
  });
}

// ---------- Light / dark theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  settings.theme = theme;
  saveSettings();
}
function toggleTheme() {
  applyTheme(settings.theme === "light" ? "dark" : "light");
}

// ---------- Camera self-view ----------
let _cameraStream = null;
async function applyCameraSetting() {
  const video = $("self-view");
  if (!video) return;
  if (settings.camera) {
    try {
      _cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = _cameraStream;
      video.classList.remove("hidden");
    } catch (e) {
      console.warn("Camera denied:", e);
      settings.camera = false;
      saveSettings();
      const t = $("camera-toggle"); if (t) t.checked = false;
    }
  } else {
    if (_cameraStream) {
      _cameraStream.getTracks().forEach(t => t.stop());
      _cameraStream = null;
    }
    video.srcObject = null;
    video.classList.add("hidden");
  }
}

// ---------- Keyboard shortcuts ----------
function wireKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Ignore when typing in form fields
    const tag = e.target.tagName;
    const typingInForm = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
    if (typingInForm && e.key !== "Escape") return;

    // ? — show hint
    if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault();
      showHotkeyHint();
      return;
    }
    // Space — push-to-talk on interview screen
    if (e.code === "Space" && screens.interview.classList.contains("active")) {
      e.preventDefault();
      if (state.recognising) stopListening();
      else startListening({ silent: true });
      return;
    }
    // Escape — cancel TTS / stop listening
    if (e.key === "Escape") {
      if (state.speaking) cancelSpeech();
      if (state.recognising) stopListening();
    }
  });
}

let _hotkeyHintEl = null;
function showHotkeyHint() {
  if (!_hotkeyHintEl) {
    _hotkeyHintEl = document.createElement("div");
    _hotkeyHintEl.className = "hotkey-hint";
    _hotkeyHintEl.innerHTML = '<kbd>Space</kbd> talk · <kbd>Esc</kbd> stop · <kbd>?</kbd> help';
    document.body.appendChild(_hotkeyHintEl);
  }
  _hotkeyHintEl.classList.add("show");
  clearTimeout(_hotkeyHintEl._t);
  _hotkeyHintEl._t = setTimeout(() => _hotkeyHintEl.classList.remove("show"), 3000);
}

// ---------- Edit transcript turn in place ----------
function makeTurnsEditable() {
  document.querySelectorAll("#transcript .turn.candidate > div:nth-child(2)").forEach(div => {
    div.setAttribute("contenteditable", "true");
    div.parentElement.classList.add("editable");
    div.addEventListener("blur", () => {
      // Editable visual cue only; we don't re-submit. This is for cosmetic
      // correction of mis-heard words so the user can clean up the transcript
      // before sharing/downloading.
    });
  });
}

// ---------- Self-assessment after an answer ----------
function maybeShowSelfAssessment(callback) {
  // Disabled by default — only show when the user opted in. Settings already
  // crowded; tuck it behind a flag the user can toggle later.
  if (!settings.selfAssess) { callback && callback(null); return; }
  // … (UI would go here)
  callback && callback(null);
}

// ---------- Track answer time for speed-of-thought ----------
function markAnswerStart() {
  state._answerStartedAt = Date.now();
}
function answerResponseMs() {
  if (!state._answerStartedAt) return null;
  const ms = Date.now() - state._answerStartedAt;
  state._answerStartedAt = null;
  return ms;
}

// ---------- init ----------
async function init() {
  loadSettings();
  // Apply theme as early as possible to avoid flash
  applyTheme(settings.theme || "dark");

  // If the URL is /share/{token}, render the read-only mentor view and stop.
  if (await openShareView()) return;

  detectCapabilities();
  if ("speechSynthesis" in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  // Probe backend TTS in the background and rewire the picker when it returns.
  loadBackendVoices();
  // Probe Whisper STT availability — if present we'll use it; else browser SR.
  probeWhisper();

  wireSetupControls();
  wireModeTabs();
  wireMaterialUpload();
  wireResumeUpload();
  wireTemplates();
  wireSettingsPanel();
  wireMicButton();
  wireCodePad();
  // Start avatar idle behaviours (blinks, sway) so the face feels alive
  // whether or not an interview is running.
  startAvatarIdle();

  // Check for a paused session to offer Resume + recent gaps to offer
  // weak-spots practice. Fire-and-forget; either may no-op silently.
  checkForResumableSession();
  checkForWeakSpots();
  loadQuestionPacks();
  wireKeyboardShortcuts();
  wireHistorySearch();

  // Theme toggle
  $("theme-toggle-btn")?.addEventListener("click", toggleTheme);

  // Language picker
  const langPicker = $("lang-picker");
  if (langPicker) {
    langPicker.value = settings.language || "en";
    langPicker.addEventListener("change", (e) => {
      settings.language = e.target.value;
      saveSettings();
      // Reload backend voices for new language prefix
      const langPrefix = `${settings.language}_`;
      fetch(API.voices(langPrefix)).then(r => r.ok ? r.json() : null).then(data => {
        if (data?.voices?.length) {
          state.backendVoices = data.voices;
          settings.voiceName = data.voices[0].name;
          populateVoicePicker();
          updateVoiceTip();
          saveSettings();
        }
      }).catch(() => {});
    });
  }

  // Camera toggle
  const camToggle = $("camera-toggle");
  if (camToggle) {
    camToggle.checked = !!settings.camera;
    camToggle.addEventListener("change", (e) => {
      settings.camera = e.target.checked;
      saveSettings();
      applyCameraSetting();
    });
    if (settings.camera) applyCameraSetting();
  }

  // Report-screen extras
  $("email-report-btn")?.addEventListener("click", emailReport);
  $("share-report-btn")?.addEventListener("click", shareReport);

  // Register service worker (PWA install support)
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  }

  $("setup-form").addEventListener("submit", startInterview);

  $("text-answer").addEventListener("input", () => {
    // User is typing: cancel auto-send-on-silence timer to give them space.
    clearSilenceTimer();
    refreshSendBtnState();
  });
  $("text-answer").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const t = $("text-answer").value.trim();
      if (t) sendAnswer(t);
    }
  });

  $("send-text-btn").addEventListener("click", () => {
    const t = $("text-answer").value.trim();
    if (t) sendAnswer(t);
  });

  $("clear-answer-btn").addEventListener("click", () => {
    $("text-answer").value = "";
    state.finalisedFromMic = "";
    state.finalisedTextBeforeMic = "";
    state.interimText = "";
    refreshSendBtnState();
    $("text-answer").focus();
  });

  $("finish-btn").addEventListener("click", () => {
    if (confirm("End the interview and generate the evaluation?")) finishInterview();
  });

  $("new-interview-btn").addEventListener("click", () => {
    state.sessionId = null;
    cancelSpeech();
    stopListening();
    showScreen("setup");
  });

  // ---- Report downloads (Word .docx) ----
  $("download-report-btn").addEventListener("click", (e) => {
    downloadDocx(state.currentReport, "full", e.currentTarget);
  });
  $("download-qa-btn").addEventListener("click", (e) => {
    downloadDocx(state.currentReport, "qa", e.currentTarget);
  });
  // Copy still uses Markdown — pasting docx blobs to clipboard isn't a thing
  // most apps handle gracefully; markdown text pastes cleanly everywhere.
  $("copy-report-btn").addEventListener("click", (e) => {
    const r = state.currentReport;
    if (!r) return;
    copyToClipboard(buildReportMarkdown(r), e.currentTarget);
  });

  // ---- History nav ----
  $("nav-history-btn").addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });
  $("history-back-btn").addEventListener("click", () => showScreen("setup"));
  $("history-clear-btn").addEventListener("click", () => {
    if (!confirm("Clear all past interview reports? This can't be undone.")) return;
    saveHistory([]);
    renderHistory();
  });

  // ---- Code-copy button ----
  const copyBtn = $("copy-code-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const code = $("code-block")?.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      } catch (_) { /* clipboard denied */ }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
