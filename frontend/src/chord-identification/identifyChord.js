import { CHORD_QUALITIES, MATCH_WEIGHTS, noteNameForClass } from "./chordLibrary";
import { makeTuningMidi, voicedNotesFromFingering } from "./fretboardNotes";

function unique(items) {
  return [...new Set(items)];
}

function rotateToRoot(noteClass, rootClass) {
  return ((noteClass - rootClass) % 12 + 12) % 12;
}

function qualityScore(intervals, quality, bassInterval) {
  const requiredSet = new Set(quality.required);
  const optionalSet = new Set(quality.optional || []);

  let missingRequired = 0;
  let missingOptional = 0;

  requiredSet.forEach((interval) => {
    if (!intervals.includes(interval)) missingRequired += 1;
  });

  optionalSet.forEach((interval) => {
    if (!intervals.includes(interval)) missingOptional += 1;
  });

  let extra = 0;
  intervals.forEach((interval) => {
    if (!requiredSet.has(interval) && !optionalSet.has(interval)) extra += 1;
  });

  const bassAdjust = bassInterval === 0
    ? -MATCH_WEIGHTS.bassRootBonus
    : MATCH_WEIGHTS.bassNonRootPenalty;

  return {
    score:
      missingRequired * MATCH_WEIGHTS.missingRequired
      + missingOptional * MATCH_WEIGHTS.missingOptional
      + extra * MATCH_WEIGHTS.extraInterval
      + bassAdjust,
    missingRequired,
    missingOptional,
    extra
  };
}

export function identifyChordFromFingering(fingering, options = {}) {
  const {
    maxMatches = 3,
    preferFlats = false,
    tuningMidi = makeTuningMidi()
  } = options;

  const voiced = voicedNotesFromFingering(fingering, tuningMidi);
  if (voiced.length < 2) {
    return {
      bestMatch: null,
      matches: [],
      noteNames: []
    };
  }

  const uniqueClasses = unique(voiced.map((note) => note.noteClass));
  const bassClass = voiced[0].noteClass;

  const candidates = [];

  uniqueClasses.forEach((rootClass) => {
    const intervals = uniqueClasses.map((pc) => rotateToRoot(pc, rootClass)).sort((a, b) => a - b);
    const bassInterval = rotateToRoot(bassClass, rootClass);

    CHORD_QUALITIES.forEach((quality) => {
      const scoreData = qualityScore(intervals, quality, bassInterval);
      if (scoreData.missingRequired > 1) return;

      const rootName = noteNameForClass(rootClass, preferFlats);
      const chord = `${rootName}${quality.suffix}`;
      const slash = bassInterval === 0 ? "" : `/${noteNameForClass(bassClass, preferFlats)}`;

      const confidence = Math.max(0, 1 - scoreData.score / 8);

      candidates.push({
        rootClass,
        qualityId: quality.id,
        chord,
        display: `${chord}${slash}`,
        confidence,
        score: scoreData.score,
        details: {
          intervals,
          bassInterval,
          ...scoreData
        }
      });
    });
  });

  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.confidence - a.confidence;
  });

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.display;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
    if (deduped.length >= maxMatches) break;
  }

  const noteNames = voiced.map((note) => noteNameForClass(note.noteClass, preferFlats));

  return {
    bestMatch: deduped[0] || null,
    matches: deduped,
    noteNames
  };
}
