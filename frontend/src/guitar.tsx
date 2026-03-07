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

interface TranslucentFretboardProps {
  data: FretboardOverlapData;
  className?: string;
}

const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E'];

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
