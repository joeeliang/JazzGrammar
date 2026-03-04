import { useMemo, useState } from "react";
import { identifyChordFromFingering } from "../chord-identification/identifyChord";

const STRING_LABELS = ["E", "A", "D", "G", "B", "e"];
const MAX_FRET = 12;
const MUTED = -1;

function isFlatKey(key) {
  return ["F", "Bb", "Eb", "Ab", "Db", "Gb"].includes(key);
}

export default function FretboardChordInput({
  displayKey = "C",
  onUseDetectedChord
}) {
  const [fingering, setFingering] = useState([0, 0, 0, 0, 0, 0]);

  const detection = useMemo(() => {
    return identifyChordFromFingering(fingering, {
      preferFlats: isFlatKey(displayKey)
    });
  }, [displayKey, fingering]);

  function setStringFret(stringIndex, fret) {
    setFingering((prev) => {
      const next = [...prev];
      next[stringIndex] = next[stringIndex] === fret ? MUTED : fret;
      return next;
    });
  }

  function resetFingering() {
    setFingering([0, 0, 0, 0, 0, 0]);
  }

  const best = detection.bestMatch;

  return (
    <section className="fretboard-input" aria-label="Fretboard chord input">
      <div className="fretboard-header">
        <div>
          <h3>Fretboard Input</h3>
          <p>Click one fret per string to detect a chord automatically.</p>
        </div>
        <div className="fretboard-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={resetFingering}
          >
            Reset shape
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => best && onUseDetectedChord?.(best.chord)}
            disabled={!best}
          >
            Use chord
          </button>
        </div>
      </div>

      <div className="fretboard-grid-wrap">
        <div className="fretboard-grid" role="grid" aria-label="Interactive guitar fretboard">
          {STRING_LABELS.map((label, stringIndex) => (
            <div key={label} className="fretboard-row" role="row">
              <div className="fretboard-string-label">{label}</div>
              <button
                type="button"
                className={fingering[stringIndex] === MUTED ? "fret-cell is-selected" : "fret-cell"}
                onClick={() => setStringFret(stringIndex, MUTED)}
                aria-label={`${label} muted`}
              >
                X
              </button>
              {Array.from({ length: MAX_FRET + 1 }, (_, fret) => (
                <button
                  key={`${label}-${fret}`}
                  type="button"
                  className={fingering[stringIndex] === fret ? "fret-cell is-selected" : "fret-cell"}
                  onClick={() => setStringFret(stringIndex, fret)}
                  aria-label={`${label} fret ${fret}`}
                >
                  {fret}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="fretboard-status">
        <div className="detected-chord">
          <span className="status-label">Detected</span>
          <strong>{best ? best.display : "-"}</strong>
        </div>
        <div className="detected-notes">
          <span className="status-label">Notes</span>
          <span>{detection.noteNames.length > 0 ? detection.noteNames.join(" - ") : "-"}</span>
        </div>
        <div className="detected-candidates">
          <span className="status-label">Alternatives</span>
          <span>
            {detection.matches.length > 1
              ? detection.matches.slice(1).map((match) => match.display).join(", ")
              : "-"}
          </span>
        </div>
      </div>
    </section>
  );
}
