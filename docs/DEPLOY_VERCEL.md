# Frontend — Vercel (Free)

The frontend is **Next.js 15, App Router** (`apps/web/src/app`), rendered client-side
(all pages are client components; there are no server actions or API routes). Vercel runs
it as a normal Next.js project. It talks to the backend over HTTP using
`NEXT_PUBLIC_API_URL`, so **the backend must be deployed first** (you need its URL).

## 1. Import the project
1. <https://vercel.com> → **Add New → Project** → import the GitHub repo.
2. **Root Directory:** set to **`apps/web`** (click *Edit* next to Root Directory and
   pick `apps/web`). This is the key monorepo setting.
3. **Framework Preset:** Next.js (auto-detected).
4. Build & install commands: leave as-is — the committed `apps/web/vercel.json` overrides
   them to build the shared workspace package first:
   ```json
   {
     "installCommand": "cd ../.. && npm install",
     "buildCommand": "cd ../.. && npm run build:shared && npm run build -w @dsa/web"
   }
   ```
   (`@dsa/shared` must be compiled before the web build resolves it.)

## 2. Environment variable
Add under **Settings → Environment Variables** (Production + Preview):

| Key | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<your-render-service>.onrender.com/api/v1` |

> **Build-time value.** `NEXT_PUBLIC_*` variables are compiled into the client bundle at
> build time. If you change `NEXT_PUBLIC_API_URL` later, you must **redeploy** the Vercel
> project for it to take effect.

`NEXT_PUBLIC_APP_NAME` is optional (defaults to `DSA Tracker`).

## 3. Deploy
1. Click **Deploy**. Vercel installs the workspace, builds `@dsa/shared`, then
   `next build`, and serves the app.
2. Copy the resulting URL, e.g. `https://dsa-tracker.vercel.app`.

## 4. Wire CORS on the backend
On the Render backend, set `CORS_ORIGINS` to the exact Vercel origin
(`https://dsa-tracker.vercel.app`, no trailing slash) and let it restart. Without this,
the browser blocks API calls from the frontend.

If you add a **custom domain** in Vercel later, add that origin to `CORS_ORIGINS` too, and
update `NEXT_PUBLIC_API_URL` only if the API domain changes (then redeploy Vercel).

## 5. Verify
- Open the Vercel URL → the login page loads.
- Sign in with the seeded admin. In browser devtools, requests should go to your
  `onrender.com` API URL (not `localhost`) and return `200`.
- Dashboard, students, leaderboards, analytics, admin all load.

## Why a Vercel project and not a static export
The app has a runtime dynamic route (`/students/[id]`) and uses Next's image optimizer;
both need the Next.js runtime that Vercel provides natively. No configuration change is
required — Vercel detects Next.js and handles it.
