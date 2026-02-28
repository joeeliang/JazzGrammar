# JazzGrammar

Visualize and apply jazz chord-progression grammar rewrites in an interactive UI.

## What this project does

- Expands Roman-numeral chord progressions with Steedman-style rewrite rules (rules 1-6, rule 0 excluded).
- Tracks and preserves chord durations during rewrites.
- Generates next-generation progression sequences from a starting progression.
- Exposes a local API for parse/suggest operations.
- Displays progression layers and substitutions in a React frontend.

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
