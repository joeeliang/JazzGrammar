const PARAM_LIMITS = {
  bpm: [60, 180],
  strumMs: [0, 100],
  attackMs: [5, 220],
  releaseMs: [120, 1800],
  cutoffHz: [500, 6000],
  filterQ: [0.2, 4],
  detuneCents: [0, 24],
  harmonicMix: [0, 1],
  masterVolume: [0.1, 1]
};

const DEFAULT_PARAMS = {
  bpm: 104,
  strumMs: 28,
  attackMs: 30,
  releaseMs: 620,
  cutoffHz: 2300,
  filterQ: 0.8,
  detuneCents: 5,
  harmonicMix: 0.35,
  masterVolume: 0.72
};

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeParams(candidate) {
  const next = { ...DEFAULT_PARAMS };
  for (const [key, [min, max]] of Object.entries(PARAM_LIMITS)) {
    next[key] = clamp(candidate?.[key], min, max, DEFAULT_PARAMS[key]);
  }
  return next;
}

function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

export class JazzyChordEngine {
  constructor(initialParams = {}) {
    this.params = normalizeParams(initialParams);
    this.audioContext = null;
    this.masterGain = null;
    this.lowpass = null;
    this.activeVoices = [];
    this.playing = false;
    this.endedTimer = null;
  }

  _ensureGraph() {
    if (this.audioContext) {
      return;
    }

    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      throw new Error("Web Audio API is not available in this browser.");
    }

    this.audioContext = new Context();
    this.masterGain = this.audioContext.createGain();
    this.lowpass = this.audioContext.createBiquadFilter();
    this.lowpass.type = "lowpass";

    this.masterGain.connect(this.lowpass);
    this.lowpass.connect(this.audioContext.destination);
  }

  setParams(nextParams) {
    this.params = normalizeParams({ ...this.params, ...(nextParams || {}) });
  }

  getParams() {
    return { ...this.params };
  }

  isPlaying() {
    return this.playing;
  }

  stop() {
    if (!this.audioContext) {
      this.playing = false;
      return;
    }

    const now = this.audioContext.currentTime;
    for (const voice of this.activeVoices) {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(0.0001, now);
      } catch {
        // Ignore cancellation errors from already ended nodes.
      }
      try {
        voice.mainOsc.stop(now + 0.01);
      } catch {
        // Ignore stop errors from already stopped nodes.
      }
      try {
        voice.harmOsc.stop(now + 0.01);
      } catch {
        // Ignore stop errors from already stopped nodes.
      }
    }

    this.activeVoices = [];
    this.playing = false;
    if (this.endedTimer) {
      window.clearTimeout(this.endedTimer);
      this.endedTimer = null;
    }
  }

  _scheduleVoice(midiNote, startAt, durationSec, releaseSec) {
    const frequency = midiToFrequency(midiNote);
    const attackSec = this.params.attackMs / 1000;

    const noteGain = this.audioContext.createGain();
    const mainMix = Math.max(0, 1 - this.params.harmonicMix);
    const harmonicMix = this.params.harmonicMix;

    const mainOsc = this.audioContext.createOscillator();
    mainOsc.type = "triangle";
    mainOsc.frequency.setValueAtTime(frequency, startAt);

    const harmonicOsc = this.audioContext.createOscillator();
    harmonicOsc.type = "sine";
    harmonicOsc.frequency.setValueAtTime(frequency * 2, startAt);
    harmonicOsc.detune.setValueAtTime(this.params.detuneCents, startAt);

    const mainGain = this.audioContext.createGain();
    mainGain.gain.setValueAtTime(mainMix, startAt);

    const harmonicGain = this.audioContext.createGain();
    harmonicGain.gain.setValueAtTime(harmonicMix, startAt);

    mainOsc.connect(mainGain);
    harmonicOsc.connect(harmonicGain);
    mainGain.connect(noteGain);
    harmonicGain.connect(noteGain);
    noteGain.connect(this.masterGain);

    const peak = 0.24;
    const noteEnd = Math.max(startAt + 0.03, startAt + durationSec);
    const peakAt = Math.min(startAt + attackSec, noteEnd - 0.005);
    const releaseStart = Math.min(noteEnd - 0.001, Math.max(peakAt + 0.005, noteEnd - releaseSec));

    noteGain.gain.setValueAtTime(0.0001, startAt);
    noteGain.gain.linearRampToValueAtTime(peak, peakAt);
    noteGain.gain.setValueAtTime(peak, releaseStart);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    mainOsc.start(startAt);
    harmonicOsc.start(startAt);
    mainOsc.stop(noteEnd + 0.05);
    harmonicOsc.stop(noteEnd + 0.05);

    this.activeVoices.push({ mainOsc, harmOsc: harmonicOsc, gain: noteGain });
  }

  async play(progression, nextParams = {}) {
    if (this.playing) {
      return { durationSec: 0 };
    }

    this.setParams(nextParams);
    this._ensureGraph();

    if (this.audioContext.state !== "running") {
      await this.audioContext.resume();
    }

    this.masterGain.gain.setValueAtTime(this.params.masterVolume, this.audioContext.currentTime);
    this.lowpass.frequency.setValueAtTime(this.params.cutoffHz, this.audioContext.currentTime);
    this.lowpass.Q.setValueAtTime(this.params.filterQ, this.audioContext.currentTime);

    const barSec = (60 / this.params.bpm) * 4;
    const strumSec = this.params.strumMs / 1000;
    const releaseSec = this.params.releaseMs / 1000;

    let cursor = this.audioContext.currentTime + 0.05;
    const startCursor = cursor;

    this.playing = true;
    this.activeVoices = [];

    const events = Array.isArray(progression) ? progression : [];
    for (const event of events) {
      const notes = Array.isArray(event?.notes)
        ? event.notes.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value))
        : [];
      const bars = Number(event?.bars);
      if (!Number.isFinite(bars) || bars <= 0) {
        continue;
      }

      const chordDurationSec = bars * barSec;
      notes.forEach((midi, index) => {
        const noteStart = cursor + (index * strumSec);
        this._scheduleVoice(midi, noteStart, chordDurationSec, releaseSec);
      });

      cursor += chordDurationSec;
    }

    const durationSec = Math.max(0, cursor - startCursor);
    if (durationSec <= 0) {
      this.playing = false;
      this.activeVoices = [];
      return { durationSec: 0 };
    }
    const totalTailMs = Math.ceil(durationSec * 1000) + 120;

    if (this.endedTimer) {
      window.clearTimeout(this.endedTimer);
    }
    this.endedTimer = window.setTimeout(() => {
      this.playing = false;
      this.activeVoices = [];
      this.endedTimer = null;
    }, totalTailMs);

    return { durationSec };
  }
}

export const defaultSynthParams = { ...DEFAULT_PARAMS };
