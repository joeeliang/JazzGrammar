export const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

// Data-first quality definitions: adjust intervals/weights here without touching matcher logic.
export const CHORD_QUALITIES = [
  {
    id: "major",
    suffix: "",
    required: [0, 4],
    optional: [7],
    aliases: ["maj"]
  },
  {
    id: "minor",
    suffix: "m",
    required: [0, 3],
    optional: [7],
    aliases: ["min"]
  },
  {
    id: "dominant7",
    suffix: "7",
    required: [0, 4, 10],
    optional: [7],
    aliases: ["dom7"]
  },
  {
    id: "major7",
    suffix: "maj7",
    required: [0, 4, 11],
    optional: [7],
    aliases: []
  },
  {
    id: "minor7",
    suffix: "m7",
    required: [0, 3, 10],
    optional: [7],
    aliases: []
  },
  {
    id: "diminished",
    suffix: "dim",
    required: [0, 3, 6],
    optional: [],
    aliases: ["°"]
  },
  {
    id: "diminished7",
    suffix: "dim7",
    required: [0, 3, 6, 9],
    optional: [],
    aliases: ["°7"]
  },
  {
    id: "halfDiminished",
    suffix: "m7b5",
    required: [0, 3, 6, 10],
    optional: [],
    aliases: ["ø7"]
  },
  {
    id: "sus4",
    suffix: "sus4",
    required: [0, 5],
    optional: [7],
    aliases: []
  },
  {
    id: "sus2",
    suffix: "sus2",
    required: [0, 2],
    optional: [7],
    aliases: []
  },
  {
    id: "augmented",
    suffix: "aug",
    required: [0, 4, 8],
    optional: [],
    aliases: ["+"]
  }
];

export const MATCH_WEIGHTS = {
  missingRequired: 4,
  missingOptional: 1,
  extraInterval: 1,
  bassRootBonus: 0.35,
  bassNonRootPenalty: 0.15
};

export function noteNameForClass(noteClass, preferFlats = false) {
  const normalized = ((noteClass % 12) + 12) % 12;
  return (preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[normalized];
}
