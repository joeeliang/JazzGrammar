# JazzGrammar

Visualize and apply jazz chord-progression grammar rewrites in an interactive UI.

## What this project does

- Expands Roman-numeral chord progressions with named generative jazz-grammar transformations.
- Tracks and preserves chord durations during rewrites.
- Generates next-generation progression sequences from a starting progression.
- Exposes a local API for parse/suggest operations.
- Displays progression layers and substitutions in a React frontend.

## Repository layout

- `backend/jazz_grammar.py`: grammar engine + CLI for progression expansion.
- `backend/api_server.py`: FastAPI HTTP API wrapper used by the React frontend.
- `backend/test_jazz_grammar.py`: unit tests for parsing and rewrite behavior.
- `frontend/`: React + Vite client application.
- `frontend/final.html`: alternative entry HTML that also boots the React app.

## Requirements

- Python 3.10+
- Node.js 18+ and npm (for frontend)

Install backend dependencies:

```bash
pip install -r backend/requirements.txt
```

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
uvicorn backend.api_server:app --host 127.0.0.1 --port 8001 --reload
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

## Frontend API configuration

The frontend reads `VITE_API_BASE_URL`.

- If unset: requests use relative paths (for example `/api/suggest`) and Vite dev proxy forwards to `http://127.0.0.1:8001`.
- If set: requests go directly to that origin (for example `https://your-render-service.onrender.com`).

Examples:

```bash
# Local development with backend on localhost:8001 (recommended default)
unset VITE_API_BASE_URL

# Local frontend hitting a remote backend
export VITE_API_BASE_URL=https://your-render-service.onrender.com
```

Local frontend env files:

- `frontend/.env.local` is ignored by git and used automatically by Vite.
- `frontend/.env.example` is committed as a template.

For full Vercel + Render deployment instructions, see `DEPLOY_VERCEL_RENDER.md`.

## Domain setup example (`joescodingadventure.com`)

If you already own `joescodingadventure.com`, this is the clean setup:

- Frontend on Vercel: `music.joescodingadventure.com`
- Backend on Render: `api.joescodingadventure.com`
- Frontend env var on Vercel: `VITE_API_BASE_URL=https://api.joescodingadventure.com`

### Recommended DNS pattern (separate frontend/backend subdomains)

1. Create the backend service on Render first and deploy it.
2. In Render, add custom domain `api.joescodingadventure.com` to your web service.
3. In your DNS provider, create the DNS record Render asks for (Render shows exact type/name/value in UI).
4. Wait for Render domain verification and SSL certificate issuance.
5. In Vercel, add custom domain `music.joescodingadventure.com` to your frontend project.
6. In your DNS provider, create the DNS record Vercel asks for (Vercel shows exact type/name/value in UI).
7. In Vercel project environment variables, set:
   `VITE_API_BASE_URL=https://api.joescodingadventure.com`
8. Redeploy frontend after setting env vars.

### Alternate pattern (single frontend domain + separate backend domain)

You can keep:

- Frontend: `music.joescodingadventure.com`
- Backend: Render default URL (for example `https://your-service.onrender.com`)

Then set:

- `VITE_API_BASE_URL=https://your-service.onrender.com`

This works immediately, but a custom API subdomain looks cleaner and is easier to lock down with CORS later.

### About “same domain for frontend and backend”

If by “same domain” you mean only one hostname (`music.joescodingadventure.com`) serving both UI and `/api/*`,
you need an extra proxy/CDN layer that can route path `/api/*` to Render and everything else to Vercel.

Without that proxy layer, use separate hostnames:

- `music.joescodingadventure.com` for frontend
- `api.joescodingadventure.com` for backend

### CORS reminder for production

Current backend default is wildcard CORS (`*`) for easy setup.
When domains are stable, set Render env var `CORS_ALLOW_ORIGINS` to explicit origins, for example:

```text
https://music.joescodingadventure.com
```

Local backend env files:

- `backend/.env.local` is ignored by git and auto-loaded by `backend/api_server.py` for local runs.
- `backend/.env.example` is committed as a template.

## Notes

- The backend currently explores depth `1` by default (`DEFAULT_SEARCH_DEPTH` in `backend/jazz_grammar.py`).
- Progression input supports `@` duration format.
- The frontend supports unit mode in `beats` or `bars` (bars are converted into grammar interval units internally using `beatsPerBar`).
- Backend CORS defaults to wildcard (`*`) for easy setup. Restrict this in production when your domain is ready.
