# Backend — Render Free Web Service

The NestJS API runs as a **single** Render Free Web Service. No Blueprint, no Render
Postgres, no Render Cron Jobs — all removed. The database is Neon; the schedule is
GitHub Actions.

## Prerequisites
- Neon `DATABASE_URL` ready (see [DEPLOY_NEON.md](DEPLOY_NEON.md)).
- This repo on GitHub, `main` branch.

## 1. Create the Web Service
1. <https://dashboard.render.com> → **New → Web Service** → connect the GitHub repo.
2. Settings:
   - **Root Directory:** `.` (repo root)
   - **Runtime:** Node
   - **Branch:** `main`
   - **Build Command:**
     ```
     npm ci --include=dev && npm run build:shared && npm run db:generate -w @dsa/api && npm run db:migrate -w @dsa/api && npm run db:seed -w @dsa/api && npm run build -w @dsa/api
     ```
     (`--include=dev` keeps build tools even with `NODE_ENV=production`; the chain also
     applies migrations and seeds so the DB is ready on first boot.)

     `db:seed` runs two steps: the admin account plus scoring formula, then the roster
     loader. In production the 60-student demo cohort is never seeded.

     The roster step is a **no-op on Render**: `roster.csv` is gitignored (real names
     and emails, public repo), so it is not in the build's checkout and the loader skips
     quietly with exit 0. Load the roster into Neon separately — see
     [DEPLOY_NEON.md](DEPLOY_NEON.md#5-load-the-roster).
   - **Start Command:**
     ```
     npm run start -w @dsa/api
     ```
   - **Health Check Path:** `/api/v1/health`
   - **Instance Type:** **Free**

## 2. Environment variables
Add these under **Environment** (see the full table in the README):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | your Neon pooled connection string |
| `QUEUE_DRIVER` | `inline` |
| `SYNC_ENABLED` | `false` (GitHub Actions drive the schedule) |
| `API_PREFIX` | `api/v1` |
| `SWAGGER_ENABLED` | `false` (set `true` if you want public docs) |
| `JWT_ACCESS_SECRET` | 48-byte random (see below) |
| `JWT_REFRESH_SECRET` | 48-byte random, **different** from the access secret |
| `CRON_SECRET` | 32-byte random; must match the GitHub secret |
| `SEED_ADMIN_EMAIL` | e.g. `admin@kalvium.com` |
| `SEED_ADMIN_PASSWORD` | a strong password (change after first login) |
| `PROGRAM_TIMEZONE` | `Asia/Kolkata` |
| `CORS_ORIGINS` | your Vercel URL, e.g. `https://your-app.vercel.app` |

Generate secrets locally:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # JWT x2
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # CRON_SECRET
```

> **Do NOT set `PORT`.** Render injects it and the app already binds `process.env.PORT`
> on `0.0.0.0`.

`CORS_ORIGINS` is chicken-and-egg with the frontend URL: set it once you know your
Vercel domain (Vercel gives you a stable `*.vercel.app` URL on the first deploy). It is
read at runtime, so updating it only needs a **restart**, not a rebuild.

## 3. Deploy & verify
- First deploy builds, migrates, seeds, and starts. Watch the logs for
  `Database connection established` and `API listening`.
- Verify:
  - `https://<service>.onrender.com/api/v1/health` → `{"status":"ok",...}`
  - `https://<service>.onrender.com/api/v1/health/ready` → `database: up`
  - Login: `POST /api/v1/auth/login` with the seeded admin returns tokens.

## Free-tier behaviour you should know
- **Cold starts:** a Free Web Service **suspends after ~15 minutes of no traffic** and
  cold-starts (~30–60s) on the next request. The GitHub Actions cron calls use long
  timeouts and retries to absorb this, and the frontend's first request after idle will
  be slow — expected, not a bug.
- **Scheduled work:** because the instance can be asleep, the schedule lives in GitHub
  Actions, which wake the backend by calling `/api/v1/internal/sync` and
  `/internal/rollup`. `SYNC_ENABLED=false` ensures the in-process scheduler doesn't also
  run them.
- **Single instance:** `QUEUE_DRIVER=inline` and the in-memory cache fallback are correct
  for one instance. Do not scale to multiple instances without adding Redis.
