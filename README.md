# JazzGrammar

Visualize and apply jazz chord-progression grammar rewrites in an interactive UI.

## What this project does

- Expands Roman-numeral chord progressions with Steedman-style rewrite rules (rules 1-6, rule 0 excluded).
- Tracks and preserves chord durations during rewrites.
- Generates next-generation progression sequences from a starting progression.
- Exposes a local API for parse/suggest operations.
- Displays progression layers and substitutions in a React frontend.

## Implemented Harmonic Changes (Current Code)

The engine currently implements **duration-aware Steedman rewrite rules 1-6** from
_A Generative Grammar for Jazz Chord Sequences_.

1. `Rule 1` split:
`x(m)(7) -> x(m) x(m)(7)`

- Any non-diminished chord can split into two equal durations.
- Second half keeps/adds dominant-seventh status from the source.

2. `Rule 2` split with subdominant:
`x(m)(7) -> x(m)(7) Sdx`

- Any non-diminished chord can split into itself plus its subdominant root.
- Duration is split equally across the two output slots.

3. `Rule 3a` dominant preparation substitution:
`w x7 -> Dx(m)7 x7`

- If a plain chord is followed by a major dominant seventh, the first slot can become
  a dominant of the second slot (major or minor dominant-seventh variant).
- Slot durations are preserved.

4. `Rule 3b` minor-dominant preparation substitution:
`w xm7 -> DX7 xm7`

- If a plain chord is followed by a minor dominant seventh, the first slot can become
  a major dominant seventh of that target.
- Slot durations are preserved.

5. `Rule 4` flat-supertonic substitution:
`DX7 x(m)(7) -> bStx(m)7 x(m)(7)`

- Replaces a dominant with a tritone-related flat-supertonic dominant while preserving
  the second chord.
- Minor/major quality of `x` is propagated to the substitute.

6. `Rule 5` tonic elaboration:
`x x x -> x Stxm Mxm`

- Applies to three identical plain major chords.
- Rewrites middle and third slots to supertonic-minor and mediant-minor.

7. `Rule 6` diminished passing insertion:
`x(m) x(m) y -> x(m) #xo7 y`

- Applies when first two slots are identical plain chords and `y` is one of:
  supertonic-minor(7), leading-tone-related, or dominant-related.
- Inserts a raised-root diminished seventh chord in the middle slot.

Related implementation behavior:

- Rules are applied to tokenized progressions (`find_next_steps`) and deduplicated.
- Durations are preserved for substitution rules and split evenly for split rules.
- Parser supports duration notation (`I@2`, `I@3/2`) and grid notation (`| I / I,ii / ii / ii |`).

## Missing Changes/Expansions

### Not Yet Implemented From Steedman (1984)

1. `Rule 0` skeleton generator:
`S12(m) -> I(m) I7 IV(m) I(m) V7 I(m)` as a first-class derivation step.

2. Optional color-tone expansion rules (Steedman rule set `(32)`), e.g. optional
`M7`, `9`, `13`, altered tensions, minor extensions.

3. Explicit context restriction for substitution legality:
Steedman constrains where `w` may match (for reversibility / avoiding bad recursion).
The current implementation enforces pattern shape but does not track all such derivational
history constraints.

4. Enharmonic reinterpretation steps used in some deep corpus derivations.

5. Additional optional cadence variants discussed by Steedman (for example interrupted
cadence variants) are not represented as explicit rules.

### Not Yet Implemented From Rohrmeier (2020)

1. Abstract syntax layer with generic categories and key-featured nonterminals.
2. Full preparation-family rules (`Delta/X`, `IV->V`, `bVI->V`, `viio/X`, `V/X`, etc.).
3. Additional diminished/voice-leading preparation rules (`Xo`, `bii^o/X`, `ii7b5/X`).
4. Unary substitution framework (`X -> Sub/X`) beyond the Steedman-specific cases.
5. Key-aware tonicization/modulation rules.
6. Keyframe tritone-substitution and backdoor-dominant formulations.
7. Borrowing/modal-interchange rule framework.
8. Phrase/form-level derivations (including Blues form templates as top-level trees).

## Suggested Next Implementation Order

1. Add derivation metadata (rule history per span) and enforce Steedman substitution
   context restrictions.
2. Add optional color-tone expansion rules (Steedman `(32)`) as a post-derivation layer.
3. Add explicit `Rule 0` generation mode for full 12-bar derivation workflows.
4. Introduce key-feature support in chord/state representation.
5. Implement Rohrmeier's preparation and substitution families on top of key-aware state.
6. Add phrase/form templates (especially Blues schema variants) once rule-level syntax is stable.

## Repository layout

- `backend/jazz_grammar.py`: grammar engine + CLI for progression expansion.
- `backend/api_server.py`: HTTP API wrapper used by the React frontend.
- `backend/test_jazz_grammar.py`: unit tests for parsing and rewrite behavior.
- `frontend/`: React + Vite client application.
- `frontend/final.html`: alternative entry HTML that also boots the React app.

## Requirements

- Python 3.10+
- Node.js 18+ and npm (for frontend)

## Backend usage

Run one-step generation from a progression:

```bash
python3 backend/jazz_grammar.py "I@4,IV@2,V7@2"
```

JSON output:

```bash
python3 backend/jazz_grammar.py --json "I@4,IV@2,V7@2"
```

Progression input formats:

- CSV tokens: `"I@4,IV@2,V7@2"`
- JSON string array: `'["I@4","IV@2","V7@2"]'`
- JSON objects with duration: `'[{"chord":"I","duration":4},{"chord":"V7","duration":2}]'`

Run API server for frontend integration:

```bash
python3 backend/api_server.py --host 127.0.0.1 --port 8001
```

## Run tests

```bash
python3 backend/test_jazz_grammar.py
```

## Frontend app

Install dependencies:

```bash
cd frontend
npm install
```

Run development server:

```bash
npm run dev
```

Then open `http://127.0.0.1:5173`.

## Notes

- The backend currently explores depth `1` by default (`DEFAULT_SEARCH_DEPTH` in `backend/jazz_grammar.py`).
- Progression input supports `@` duration format.
- The frontend supports unit mode in `beats` or `bars` (bars are converted into grammar interval units internally using `beatsPerBar`).
