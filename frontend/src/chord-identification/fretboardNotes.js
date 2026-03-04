export const STANDARD_TUNING = ["E2", "A2", "D3", "G3", "B3", "E4"];

const NOTE_TO_CLASS = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11
};

function parseNoteToken(token) {
  const match = String(token).trim().match(/^([A-G](?:#|b)?)(-?\d+)$/);
  if (!match) {
    throw new Error(`Invalid note token '${token}'`);
  }
  const [, noteName, octaveText] = match;
  const pitchClass = NOTE_TO_CLASS[noteName];
  if (pitchClass == null) {
    throw new Error(`Invalid note name '${noteName}'`);
  }
  const octave = Number(octaveText);
  return (octave + 1) * 12 + pitchClass;
}

export function makeTuningMidi(tuning = STANDARD_TUNING) {
  return tuning.map((token) => parseNoteToken(token));
}

export function voicedNotesFromFingering(fingering, tuningMidi = makeTuningMidi()) {
  return fingering
    .map((fret, stringIndex) => {
      if (!Number.isInteger(fret) || fret < 0) return null;
      const midi = tuningMidi[stringIndex] + fret;
      return {
        stringIndex,
        fret,
        midi,
        noteClass: ((midi % 12) + 12) % 12
      };
    })
    .filter(Boolean);
}
