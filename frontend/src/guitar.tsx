import { useEffect, useId, useMemo, useState } from 'react';

export interface FretboardSharedNote {
  string: number; // 0 = high e, 5 = low E
  fret: number;
  note?: string;
  interval_a: string;
  interval_b: string;
}

export interface FretboardMovingNote {
  string: number; // 0 = high e, 5 = low E
  fret_start: number;
  fret_end: number;
  note_start?: string;
  note_end?: string;
}

export interface FretboardVoicingPoint {
  string: number;
  fret: number;
}

export interface FretboardOverlapData {
  chord_a_name: string;
  chord_b_name: string;
  fret_window: [number, number];
  shared_notes: FretboardSharedNote[];
  moving_notes: FretboardMovingNote[];
  voicing_a: FretboardVoicingPoint[];
  voicing_b: FretboardVoicingPoint[];
  shared_count: number;
  movement_cost: number;
}

export interface ChordIdentifyCandidate {
  name: string;
  score?: number;
}

export interface ChordIdentifyResponse {
  candidates: ChordIdentifyCandidate[];
}

interface TranslucentFretboardProps {
  data: FretboardOverlapData;
  className?: string;
}

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];

const MAX_FRET = 12;
const buildEmptyFrets = () => [null, null, null, null, null, null] as Array<number | null>;
const AUTO_IDENTIFY_DEBOUNCE_MS = 180;

const clampWindow = (window: [number, number]): [number, number] => {
  const start = Math.max(0, Math.floor(window[0]));
  const end = Math.max(start + 3, Math.floor(window[1]));
  return [start, end];
};

const pointKey = (stringIndex: number, fret: number) => `${stringIndex}:${fret}`;

export default function TranslucentFretboard({ data, className = '' }: TranslucentFretboardProps) {
  const [animateMovement, setAnimateMovement] = useState(false);
  const arrowId = useId().replace(/:/g, '-');

  const [fretStart, fretEnd] = useMemo(() => clampWindow(data.fret_window), [data.fret_window]);

  useEffect(() => {
    setAnimateMovement(false);
    const timer = window.setTimeout(() => setAnimateMovement(true), 300);
    return () => window.clearTimeout(timer);
  }, [data]);

  const fretCount = Math.max(1, fretEnd - fretStart + 1);
  const svgWidth = 720;
  const svgHeight = 180;
  const left = 44;
  const right = 20;
  const top = 18;
  const bottom = 30;
  const fretboardWidth = svgWidth - left - right;
  const fretboardHeight = svgHeight - top - bottom;

  const xForFretLine = (fret: number) => left + ((fret - fretStart) / fretCount) * fretboardWidth;
  const xForFretCenter = (fret: number) => left + ((fret - fretStart + 0.5) / fretCount) * fretboardWidth;
  const yForString = (stringIndex: number) => top + (stringIndex / 5) * fretboardHeight;

  const noteAByPosition = new Map<string, string>();
  const noteBByPosition = new Map<string, string>();

  data.shared_notes.forEach((note) => {
    if (note.note) {
      const key = pointKey(note.string, note.fret);
      noteAByPosition.set(key, note.note);
      noteBByPosition.set(key, note.note);
    }
  });

  data.moving_notes.forEach((note) => {
    const startKey = pointKey(note.string, note.fret_start);
    const endKey = pointKey(note.string, note.fret_end);
    if (note.note_start) {
      noteAByPosition.set(startKey, note.note_start);
    }
    if (note.note_end) {
      noteBByPosition.set(endKey, note.note_end);
    }
  });

  const chordANotes = [
    ...data.shared_notes.map((note) => note.note).filter((note): note is string => Boolean(note)),
    ...data.moving_notes.map((note) => note.note_start).filter((note): note is string => Boolean(note)),
  ];
  const chordBNotes = [
    ...data.shared_notes.map((note) => note.note).filter((note): note is string => Boolean(note)),
    ...data.moving_notes.map((note) => note.note_end).filter((note): note is string => Boolean(note)),
  ];

  const sharedNoteNames = useMemo(() => {
    const setA = new Set(chordANotes);
    return Array.from(new Set(chordBNotes.filter((note) => setA.has(note))));
  }, [chordANotes, chordBNotes]);

  const overlapPercentage = useMemo(() => {
    const unique = new Set([...chordANotes, ...chordBNotes]).size;
    if (unique === 0) {
      return 0;
    }
    return Math.round((sharedNoteNames.length / unique) * 100);
  }, [chordANotes, chordBNotes, sharedNoteNames]);

  const movingByString = new Map<number, FretboardMovingNote>();
  data.moving_notes.forEach((note) => movingByString.set(note.string, note));

  const positionIsShared = new Set(data.shared_notes.map((note) => pointKey(note.string, note.fret)));

  const frets = Array.from({ length: fretCount + 1 }, (_, index) => fretStart + index);

  return (
    <div className={`w-full rounded-xl border border-[#ddd2c2] bg-[#f7f1e8] px-3 py-2 shadow-[0_10px_28px_-24px_rgba(58,43,31,0.7)] ${className}`}>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div>
          <p className="scientific-text text-sm italic leading-none text-[#2f241d]">
            {data.chord_a_name} {'->'} {data.chord_b_name}
          </p>
          <p className="mt-1 text-[9px] uppercase tracking-[0.18em] text-[#8a7a69]">Guitar Voicing Overlap</p>
        </div>
        <div className="text-right">
          <p className="text-[9px] uppercase tracking-[0.14em] text-[#8a7a69]">Strength</p>
          <p className="text-sm font-semibold text-[#2f241d]">{overlapPercentage}%</p>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-1 overflow-x-auto text-[9px]">
        {sharedNoteNames.length > 0 ? (
          sharedNoteNames.map((note) => (
            <span key={note} className="rounded-md border border-[#d7cdbd] bg-[#efe6d8] px-1.5 py-0.5 font-medium text-[#6d5a48]">
              {note}
            </span>
          ))
        ) : (
          <span className="italic text-[#988776]">No shared tones</span>
        )}
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="h-[140px] min-w-[560px] w-full">
          <defs>
            <linearGradient id={`fretboardFill-${arrowId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4a3527" />
              <stop offset="100%" stopColor="#342518" />
            </linearGradient>
            <pattern id={`woodgrain-${arrowId}`} width="16" height="16" patternUnits="userSpaceOnUse">
              <path d="M0 5 H16 M0 11 H16" stroke="#8b7058" strokeWidth="0.4" opacity="0.22" />
            </pattern>
            <marker id={`trailArrow-${arrowId}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill="#c07266" />
            </marker>
          </defs>

          <rect x={left} y={top} width={fretboardWidth} height={fretboardHeight} rx={8} fill={`url(#fretboardFill-${arrowId})`} />
          <rect x={left} y={top} width={fretboardWidth} height={fretboardHeight} rx={8} fill={`url(#woodgrain-${arrowId})`} opacity={0.5} />

          {STRING_LABELS.map((label, stringIndex) => {
            const y = yForString(stringIndex);
            return (
              <g key={`string-${label}-${stringIndex}`}>
                <line
                  x1={left}
                  y1={y}
                  x2={left + fretboardWidth}
                  y2={y}
                  stroke="#d8cab7"
                  strokeWidth={Math.max(0.9, 1.8 - stringIndex * 0.16)}
                  opacity={0.78}
                />
                <text x={left - 14} y={y + 3} fontSize="9" fill="#9c8b79" textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}

          {frets.map((fret, index) => {
            const x = xForFretLine(fret);
            const isNut = fret === fretStart;
            return (
              <g key={`fret-${fret}-${index}`}>
                <line
                  x1={x}
                  y1={top}
                  x2={x}
                  y2={top + fretboardHeight}
                  stroke={isNut ? '#eadfce' : '#826a52'}
                  strokeWidth={isNut ? 2.4 : 1.1}
                  opacity={isNut ? 0.95 : 0.62}
                />
                {index < fretCount && (
                  <text
                    x={xForFretCenter(fret)}
                    y={top + fretboardHeight + 15}
                    fontSize="8"
                    fill="#a18f7d"
                    textAnchor="middle"
                  >
                    {fret}
                  </text>
                )}
              </g>
            );
          })}

          {data.voicing_a.map((point, index) => {
            const key = pointKey(point.string, point.fret);
            const overlap = positionIsShared.has(key);
            return (
              <g key={`a-${index}`}>
                <circle
                  cx={xForFretCenter(point.fret) + (overlap ? -2 : 0)}
                  cy={yForString(point.string)}
                  r={7.6}
                  fill="#f1d0bc"
                  stroke="#f6e9de"
                  strokeWidth={0.9}
                  opacity={0.82}
                />
                <text
                  x={xForFretCenter(point.fret) + (overlap ? -2 : 0)}
                  y={yForString(point.string) + 3}
                  fontSize="8"
                  fill="#3a2a1f"
                  textAnchor="middle"
                >
                  {noteAByPosition.get(key) ?? ''}
                </text>
              </g>
            );
          })}

          {data.shared_notes.map((note, index) => (
            <g key={`shared-${index}`}>
              <circle cx={xForFretCenter(note.fret)} cy={yForString(note.string)} r={6.4} fill="#d3b063" opacity={0.92}>
                <animate attributeName="opacity" values="0.82;1;0.82" dur="1.7s" repeatCount="indefinite" />
              </circle>
                <text
                  x={xForFretCenter(note.fret)}
                  y={yForString(note.string) + 18}
                  fontSize="7"
                  fill="#b8a792"
                  textAnchor="middle"
                >
                  {note.interval_a}
                  {'->'}
                  {note.interval_b}
                </text>
            </g>
          ))}

          {data.moving_notes.map((note, index) => {
            const x1 = xForFretCenter(note.fret_start);
            const x2 = xForFretCenter(note.fret_end);
            const y = yForString(note.string);
            return (
              <line
                key={`trail-${index}`}
                x1={x1}
                y1={y}
                x2={x2}
                y2={y}
                stroke="#c07266"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                markerEnd={`url(#trailArrow-${arrowId})`}
                opacity={animateMovement ? 0.82 : 0}
                style={{ transition: 'opacity 280ms ease-in-out' }}
              />
            );
          })}

          {data.voicing_b.map((point, index) => {
            const key = pointKey(point.string, point.fret);
            const overlap = positionIsShared.has(key);
            const moving = movingByString.get(point.string);
            const renderFret =
              moving && moving.fret_end === point.fret && !overlap && !animateMovement ? moving.fret_start : point.fret;
            const x = xForFretCenter(renderFret) + (overlap ? 2 : 0);

            return (
              <g key={`b-${index}`}>
                <circle
                  cx={x}
                  cy={yForString(point.string)}
                  r={7.6}
                  fill="#bcd1ef"
                  stroke="#e0ebfa"
                  strokeWidth={0.9}
                  opacity={0.9}
                  style={{ transition: 'cx 420ms ease-in-out' }}
                />
                <text x={x} y={yForString(point.string) + 3} fontSize="8" fill="#253043" textAnchor="middle" style={{ transition: 'x 420ms ease-in-out' }}>
                  {noteBByPosition.get(key) ?? ''}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-1 flex items-center justify-between text-[9px] uppercase tracking-[0.12em] text-[#8f7f6d]">
        <span>Shared {data.shared_count}</span>
        <span>Movement {data.movement_cost}</span>
      </div>
    </div>
  );
}

interface ChordPickerCardProps {
  apiUrl: string;
  position: { x: number; y: number };
  onPick: (chordName: string) => void;
  onClose: () => void;
  maxSuggestions?: number;
}

export function ChordPickerCard({
  apiUrl,
  position,
  onPick,
  onClose,
  maxSuggestions = 5,
}: ChordPickerCardProps) {
  const [frets, setFrets] = useState<Array<number | null>>(buildEmptyFrets);
  const [candidates, setCandidates] = useState<ChordIdentifyCandidate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fretCount = MAX_FRET + 1;
  const svgWidth = 640;
  const svgHeight = 230;
  const left = 38;
  const right = 22;
  const top = 22;
  const bottom = 42;
  const fretboardWidth = svgWidth - left - right;
  const fretboardHeight = svgHeight - top - bottom;

  const xForFretLine = (lineIndex: number) => left + (lineIndex / fretCount) * fretboardWidth;
  const xForFretCenter = (fret: number) => left + ((fret + 0.5) / fretCount) * fretboardWidth;
  const yForString = (stringIndex: number) => top + (stringIndex / 5) * fretboardHeight;

  const setStringFret = (stringIndex: number, fret: number) => {
    setFrets((prev) => {
      const next = [...prev];
      next[stringIndex] = next[stringIndex] === fret ? null : fret;
      return next;
    });
  };

  const clearFrets = () => {
    setFrets(buildEmptyFrets());
    setCandidates([]);
    setError(null);
  };

  const selectedCount = useMemo(() => frets.filter((fret) => fret !== null).length, [frets]);

  const identify = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fretsForApi = [frets[5], frets[4], frets[3], frets[2], frets[1], frets[0]];
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frets: fretsForApi }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }
      const body = (await response.json()) as ChordIdentifyResponse;
      setCandidates(body.candidates.slice(0, maxSuggestions));
    } catch (err) {
      setCandidates([]);
      setError(err instanceof Error ? err.message : 'Failed to identify chord.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (frets.every((fret) => fret === null)) {
      setCandidates([]);
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void identify();
    }, AUTO_IDENTIFY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [frets]);

  return (
    <div
      className="chord-picker-container fixed z-[110] w-[680px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-[#e3d6c4] bg-[#fffaf4] p-3 shadow-[0_24px_80px_-40px_rgba(47,32,16,0.9)]"
      style={{ left: position.x, top: position.y }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#8a7661]">Fretboard Input</p>
          <p className="text-sm font-semibold text-[#2f241d]">Pick notes to identify a chord</p>
          <p className="mt-1 text-[10px] text-[#8a7764]">
            Click between fret wires on each string. Click the same spot again to mute that string.
          </p>
        </div>
        <button onClick={onClose} className="rounded-full px-2 py-1 text-[11px] text-[#7a6754] hover:bg-[#f2e8dc]">
          Close
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#ddd2c2] bg-[#f7f1e8] px-2 py-2">
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="h-[190px] min-w-[620px] w-full">
          <defs>
            <linearGradient id="picker-fretboard-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4a3527" />
              <stop offset="100%" stopColor="#342518" />
            </linearGradient>
            <pattern id="picker-woodgrain" width="16" height="16" patternUnits="userSpaceOnUse">
              <path d="M0 5 H16 M0 11 H16" stroke="#8b7058" strokeWidth="0.4" opacity="0.22" />
            </pattern>
          </defs>

          <rect x={left} y={top} width={fretboardWidth} height={fretboardHeight} rx={8} fill="url(#picker-fretboard-fill)" />
          <rect x={left} y={top} width={fretboardWidth} height={fretboardHeight} rx={8} fill="url(#picker-woodgrain)" opacity={0.5} />

          {Array.from({ length: 6 }, (_, stringIndex) => (
            <g key={`picker-string-${stringIndex}`}>
              <line
                x1={left}
                y1={yForString(stringIndex)}
                x2={left + fretboardWidth}
                y2={yForString(stringIndex)}
                stroke="#d8cab7"
                strokeWidth={Math.max(0.9, 1.8 - stringIndex * 0.16)}
                opacity={0.78}
              />
              <text x={left - 14} y={yForString(stringIndex) + 3} fontSize="9" fill="#9c8b79" textAnchor="middle">
                {STRING_LABELS[stringIndex]}
              </text>
            </g>
          ))}

          {Array.from({ length: fretCount + 1 }, (_, lineIndex) => {
            const x = xForFretLine(lineIndex);
            const isNut = lineIndex === 0;
            return (
              <g key={`picker-fretline-${lineIndex}`}>
                <line
                  x1={x}
                  y1={top}
                  x2={x}
                  y2={top + fretboardHeight}
                  stroke={isNut ? '#eadfce' : '#826a52'}
                  strokeWidth={isNut ? 2.4 : 1.1}
                  opacity={isNut ? 0.95 : 0.62}
                />
                {lineIndex < fretCount && (
                  <text x={xForFretCenter(lineIndex)} y={top + fretboardHeight + 16} fontSize="8" fill="#a18f7d" textAnchor="middle">
                    {lineIndex}
                  </text>
                )}
              </g>
            );
          })}

          {Array.from({ length: 6 }, (_, stringIndex) =>
            Array.from({ length: fretCount }, (_, fret) => {
              const yCenter = yForString(stringIndex);
              const topBound = stringIndex === 0 ? top : (yForString(stringIndex - 1) + yCenter) / 2;
              const bottomBound = stringIndex === 5 ? top + fretboardHeight : (yCenter + yForString(stringIndex + 1)) / 2;
              const xLeft = xForFretLine(fret);
              const xRight = xForFretLine(fret + 1);
              return (
                <rect
                  key={`picker-hit-${stringIndex}-${fret}`}
                  x={xLeft}
                  y={topBound}
                  width={xRight - xLeft}
                  height={bottomBound - topBound}
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setStringFret(stringIndex, fret)}
                />
              );
            }),
          )}

          {frets.map((fret, stringIndex) => {
            if (fret === null) {
              return (
                <text
                  key={`picker-muted-${stringIndex}`}
                  x={left - 28}
                  y={yForString(stringIndex) + 3}
                  fontSize="10"
                  fill="#b66b62"
                  textAnchor="middle"
                >
                  x
                </text>
              );
            }
            return (
              <circle
                key={`picker-note-${stringIndex}`}
                cx={xForFretCenter(fret)}
                cy={yForString(stringIndex)}
                r={8}
                fill="#f1d0bc"
                stroke="#f6e9de"
                strokeWidth={1}
              />
            );
          })}
        </svg>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={identify}
          className="rounded-full border border-[#d8cdbf] bg-[#fffaf3] px-3 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-[#3f3328] shadow-[0_12px_30px_-24px_rgba(48,34,18,0.85)]"
        >
          {isLoading ? 'Identifying...' : 'Identify'}
        </button>
        <button
          onClick={clearFrets}
          className="rounded-full border border-[#e1d6c8] bg-white px-3 py-1.5 text-[11px] text-[#7a6754] hover:bg-[#f4eee6]"
        >
          Clear
        </button>
        <span className="text-[10px] text-[#7d6b58]">{selectedCount} string{selectedCount === 1 ? '' : 's'} active</span>
        {error && <span className="text-[10px] text-[#b8574d]">{error}</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {candidates.length === 0 ? (
          <span className="text-[10px] italic text-[#9b8873]">No chord suggestions yet.</span>
        ) : (
          candidates.map((candidate) => (
            <button
              key={candidate.name}
              onClick={() => onPick(candidate.name)}
              className="rounded-full border border-[#d8cdbf] bg-white px-3 py-1 text-[11px] font-semibold text-[#3f3328] hover:border-[#b67a3c] hover:bg-[#f7ecde]"
            >
              {candidate.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
