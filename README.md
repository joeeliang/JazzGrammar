# JazzGrammar

Visualize jazz chord-progression grammar generations as a tree diagram.

## What this project does

- Expands Roman-numeral chord progressions with Steedman-style rewrite rules (rules 1-6, rule 0 excluded).
- Tracks and preserves chord durations during rewrites.
- Generates next-generation progression sequences from a starting progression.
- Displays generated structures in a tree-style browser visualization.

## Repository layout

- `backend/jazz_grammar.py`: grammar engine + CLI for progression expansion.
- `backend/test_jazz_grammar.py`: unit tests for parsing and rewrite behavior.
- `final.html`: interactive tree visualization page.
- `frontend/tree.html`: simple D3 tree demo page.
- `frontend/`: Vite/React scaffold (currently references `/src/main.jsx`, which is not present in this repo).

## Requirements

- Python 3.10+
- (Optional) Node.js 18+ and npm, if you want to work on the frontend scaffold

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

## Run tests

```bash
python3 backend/test_jazz_grammar.py
```

## Tree visualization

Serve the repo and open the visualization:

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/final.html` for the main interactive chord tree view
- `http://localhost:8000/frontend/tree.html` for a minimal D3 tree demo

## Notes

- The backend currently explores depth `1` by default (`DEFAULT_SEARCH_DEPTH` in `backend/jazz_grammar.py`).
- `frontend/index.html` points to a React entry file that is not committed (`/src/main.jsx`), so `npm run dev` in `frontend/` will need those source files before it can run.
