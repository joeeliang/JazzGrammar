import { useMemo, useState } from 'react';

const DEMO_INPUT = 'I | V | IIm | V7';
const ROMAN_ROOT_RE = /^([b#♭♯]*)(VII|VI|IV|V|III|II|I)$/;

function parseChords(input) {
  return input
    .split(/\||,|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function highlightSet(range) {
  return new Set(range || []);
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function normalizeFraction(numerator, denominator) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    return null;
  }
  const sign = numerator < 0 ? -1 : 1;
  const g = gcd(numerator, denominator);
  return { numerator: (sign * Math.abs(numerator)) / g, denominator: denominator / g };
}

function parseFraction(text) {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.includes('/')) {
    const [nText, dText] = raw.split('/');
    const n = Number(nText);
    const d = Number(dText);
    if (!Number.isInteger(n) || !Number.isInteger(d) || d <= 0 || n <= 0) return null;
    return normalizeFraction(n, d);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { numerator: n, denominator: 1 };
}

function halfFraction(frac) {
  return normalizeFraction(frac.numerator, frac.denominator * 2);
}

function formatFraction(frac) {
  if (frac.denominator === 1) return String(frac.numerator);
  return `${frac.numerator}/${frac.denominator}`;
}

function parseRomanTimedChord(token) {
  const raw = token.trim();
  if (!raw) return null;

  const atIdx = raw.lastIndexOf('@');
  const chordText = atIdx >= 0 ? raw.slice(0, atIdx).trim() : raw;
  const durationText = atIdx >= 0 ? raw.slice(atIdx + 1).trim() : '1';
  const duration = parseFraction(durationText);
  if (!duration) return null;

  let core = chordText;
  let minor = false;
  let dominant7 = false;
  let diminished7 = false;

  if (core.endsWith('°7')) {
    diminished7 = true;
    core = core.slice(0, -2);
  } else if (core.endsWith('m7')) {
    minor = true;
    dominant7 = true;
    core = core.slice(0, -2);
  } else if (core.endsWith('7')) {
    dominant7 = true;
    core = core.slice(0, -1);
  } else if (core.endsWith('m')) {
    minor = true;
    core = core.slice(0, -1);
  }

  if (!ROMAN_ROOT_RE.test(core)) return null;
  return { root: core, minor, dominant7, diminished7, duration };
}

function formatRomanTimedChord(chord, duration) {
  let token = chord.root;
  if (chord.diminished7) token += '°7';
  else if (chord.dominant7) token += chord.minor ? 'm7' : '7';
  else if (chord.minor) token += 'm';
  if (duration.numerator === 1 && duration.denominator === 1) return token;
  return `${token}@${formatFraction(duration)}`;
}

function fallbackRule1Expansion(chordToken) {
  const raw = chordToken.trim();
  if (!raw) return null;
  if (/°7|dim7/i.test(raw)) return null;

  const hasSeventh = /(maj7|M7|Δ7|m7|-7|7)/i.test(raw);
  const isMinor = /m(?!aj)|min/i.test(raw);
  const seventh = hasSeventh ? raw : `${raw}${isMinor ? '7' : '7'}`;
  return [raw, seventh];
}

function buildRule1Suggestions(chords) {
  const out = [];
  for (let i = 0; i < chords.length; i += 1) {
    const token = chords[i];
    const roman = parseRomanTimedChord(token);

    if (roman && !roman.diminished7) {
      const half = halfFraction(roman.duration);
      if (!half) continue;
      const first = formatRomanTimedChord(
        { root: roman.root, minor: roman.minor, dominant7: false, diminished7: false },
        half
      );
      const second = formatRomanTimedChord(
        { root: roman.root, minor: roman.minor, dominant7: true, diminished7: false },
        half
      );
      const result = [...chords.slice(0, i), first, second, ...chords.slice(i + 1)];
      out.push({
        id: `${i}-${token}`,
        title: `Rule 1 at chord ${i + 1}`,
        type: 'expansion',
        replaceRange: [i],
        replacement: [first, second],
        result,
        rationale: `${token} -> ${first} ${second}`
      });
      continue;
    }

    const fallback = fallbackRule1Expansion(token);
    if (!fallback) continue;
    const result = [...chords.slice(0, i), ...fallback, ...chords.slice(i + 1)];
    out.push({
      id: `${i}-${token}`,
      title: `Rule 1 at chord ${i + 1}`,
      type: 'expansion',
      replaceRange: [i],
      replacement: fallback,
      result,
      rationale: `${token} -> ${fallback[0]} ${fallback[1]}`
    });
  }
  return out;
}

function SuggestionCard({ suggestion, chords }) {
  const highlighted = useMemo(() => highlightSet(suggestion.replaceRange), [suggestion.replaceRange]);

  return (
    <article className="suggestion-card">
      <header>
        <h3>{suggestion.title}</h3>
        <p>{suggestion.type}</p>
      </header>

      <div className="chord-line">
        {chords.map((chord, idx) => (
          <span key={`${suggestion.id}-${chord}-${idx}`} className={highlighted.has(idx) ? 'token replaced' : 'token'}>
            {chord}
          </span>
        ))}
      </div>

      <div className="replacement-block">
        <span className="replacement-label">Replacement</span>
        <div className="replacement-line">
          {suggestion.replacement.map((chord, idx) => (
            <span key={`${suggestion.id}-new-${chord}-${idx}`} className="token incoming">
              {chord}
            </span>
          ))}
        </div>
      </div>

      <div className="replacement-block">
        <span className="replacement-label">Expanded Progression</span>
        <div className="replacement-line">
          {suggestion.result.map((chord, idx) => (
            <span key={`${suggestion.id}-result-${chord}-${idx}`} className="token incoming">
              {chord}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [progressionInput, setProgressionInput] = useState(DEMO_INPUT);
  const [chords, setChords] = useState(parseChords(DEMO_INPUT));
  const [suggestions, setSuggestions] = useState(buildRule1Suggestions(parseChords(DEMO_INPUT)));
  const [errorText, setErrorText] = useState('');

  const generateSuggestions = () => {
    const parsed = parseChords(progressionInput);
    setChords(parsed);
    setErrorText('');

    if (parsed.length === 0) {
      setSuggestions([]);
      setErrorText('Enter at least one chord token.');
      return;
    }

    const next = buildRule1Suggestions(parsed);
    setSuggestions(next);
    if (next.length === 0) {
      setErrorText('No Rule 1 expansions found for these tokens.');
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-title-row">
          <h2>Rule 1 Expansions</h2>
          <span className="count">{suggestions.length}</span>
        </div>
        <p className="sidebar-subtitle">Depth: 1 layer</p>
        <ul>
          {suggestions.map((item) => (
            <li key={item.id}>
              <span>{item.rationale}</span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main-canvas">
        <section className="composer">
          <h1>Progression Workspace</h1>
          <p>Enter chords split by |, comma, or newline. Rule 1 expands each chord into itself and its 7th.</p>
          <textarea
            value={progressionInput}
            onChange={(event) => setProgressionInput(event.target.value)}
            spellCheck={false}
            aria-label="Chord progression input"
          />
          {errorText ? <p className="error-text">{errorText}</p> : null}
          <button type="button" onClick={generateSuggestions}>
            Expand Rule 1
          </button>
        </section>

        <section className="suggestion-grid" aria-live="polite">
          {suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} chords={chords} />
          ))}
          {!suggestions.length ? <p className="empty-state">No expansions to display.</p> : null}
        </section>

        <section className="llm-box">
          <h4>Rule 1</h4>
          <p>
            A single chord is expanded into two half-duration slots: the chord itself, then its seventh variant.
          </p>
        </section>
      </main>
    </div>
  );
}
