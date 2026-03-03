This guide matches the current codebase:

- Frontend: Vite + React in `frontend/`
- Backend: FastAPI app in `backend/api_server.py`
- Backend start command: `uvicorn backend.api_server:app --host 0.0.0.0 --port $PORT`

## 1) Local development workflow

Backend (terminal 1):

```bash
pip install -r backend/requirements.txt
uvicorn backend.api_server:app --host 127.0.0.1 --port 8001 --reload
```

Frontend (terminal 2):

```bash
cd frontend
npm install
npm run dev
```

Default local behavior:

- Leave `VITE_API_BASE_URL` unset.
- Frontend calls `/api/*` and Vite proxy forwards to `http://127.0.0.1:8001`.

Optional local override to test against remote Render backend:

```bash
cd frontend
export VITE_API_BASE_URL=https://your-render-service.onrender.com
npm run dev
```

## 2) Deploy backend on Render (native Python)

1. Push this repo to GitHub.
2. In Render, create a new **Web Service** and connect the repo.
3. Use these settings:

- Environment: `Python`
- Build Command: `pip install -r backend/requirements.txt`
- Start Command: `uvicorn backend.api_server:app --host 0.0.0.0 --port $PORT`

4. Add environment variables:

- `CORS_ALLOW_ORIGINS=*` (current default)

5. Deploy and copy the backend URL, for example:

- `https://jazz-grammar-api.onrender.com`

Health check endpoint:

- `GET https://your-service.onrender.com/api/health`

## 3) Deploy frontend on Vercel

1. Import the same GitHub repo into Vercel.
2. In project settings, set **Root Directory** to `frontend`.
3. Set framework preset to `Vite` (auto-detected in most cases).
4. Add environment variable:

- `VITE_API_BASE_URL=https://your-render-service.onrender.com`

5. Deploy.

After deploy, open the app and confirm parse/suggest calls succeed.

## 4) Domain options (documented both ways)

## Option A: Separate domains/subdomains (recommended)

- Frontend: `https://yourdomain.com` (or `https://app.yourdomain.com`)
- Backend: `https://api.yourdomain.com`
- Vercel env var: `VITE_API_BASE_URL=https://api.yourdomain.com`

Pros:

- Clear frontend/backend separation
- Simple routing model

## Option B: Single domain with path routing (`/api`)

Example:

- Frontend and backend both under `https://yourdomain.com`
- Requests to `/api/*` forwarded to Render backend

This requires an external proxy/CDN layer in front of Vercel + Render that supports path-based routing.
Without that proxy layer, use Option A.

## 5) Security note (important)

Current backend CORS setting allows all origins (`*`) for fast setup.
This is convenient but not ideal for production security.

When your domain is ready, set `CORS_ALLOW_ORIGINS` on Render to explicit origins, for example:

```text
https://yourdomain.com,https://www.yourdomain.com
```

Then redeploy backend.

## 6) Quick verification checklist

1. Backend health endpoint returns `{"ok": true}`.
2. Frontend loads and displays default progression.
3. Clicking **Start** returns suggestions.
4. Applying a suggestion updates the diagram and generated grid.
5. Browser devtools show API requests going to the expected backend URL.
