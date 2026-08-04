# Deploying DSA Tracker to Render

This repo ships a Render Blueprint (`render.yaml`) that provisions the whole stack:

| Render service | Type | What it is |
|---|---|---|
| `dsa-db` | PostgreSQL | The only stateful component. |
| `dsa-api` | Web Service | NestJS API. Binds Render's `$PORT` on `0.0.0.0`; health check at `/api/v1/health`. |
| `dsa-web` | Web Service | Next.js frontend (`next start`). Client-rendered, but needs the Next server for its dynamic route and image optimizer. |
| `dsa-sync` | Cron Job | Incremental LeetCode sync, every 3 hours (UTC). |
| `dsa-rollup` | Cron Job | Nightly leaderboard/streak rebuild + housekeeping, 19:00 UTC (= 00:30 IST). |

**Why cron jobs instead of the in-process scheduler?** The API's built-in scheduler
(`@nestjs/schedule`) only fires while the API process is awake — on an idle-suspended
web service it silently stops. The two cron jobs fire on schedule regardless, so
scheduled syncs keep working. The API therefore runs with `SYNC_ENABLED=false` to avoid
doing the same work twice.

> **Tiers & cost:** this blueprint pins no instance plans — choose them in the dashboard.
> Verify current plan availability and pricing on Render before you commit; the design
> works whether you run everything on the smallest paid tier or mix in free instances.
> One caveat if you use free web instances: they suspend when idle and cold-start on the
> next request — fine for an internal tool, and it does **not** affect the cron jobs.

---

## The two things that trip everyone up

1. **`NEXT_PUBLIC_API_URL` is baked into the frontend at _build_ time.** Changing it in
   the dashboard does nothing until you **redeploy `dsa-web`**. So the order below is:
   deploy the API first → copy its URL → set it on the web service → deploy the web
   service. Do it out of order and the frontend ships pointing at `localhost:4000`.

2. **Never set a `PORT` variable on Render.** Render injects `PORT` and both apps read
   it. Setting your own makes the host report *"no open ports detected."*

---

## Step-by-step

### 0. Prerequisites (manual)
- Push this repository to GitHub (the target repo is
  `Gosling-dude/Kalvium-student-leetcode-tracker`).
- Have a Render account with that GitHub account connected
  (Render dashboard → **Account Settings → GitHub → Connect**).

### 1. Create the Blueprint
- Render dashboard → **New → Blueprint**.
- Select this repository. Render reads `render.yaml` and lists the 5 resources.
- When prompted for the variables marked *"sync: false"*, provide:
  - **`dsa-api` → `SEED_ADMIN_PASSWORD`** — a strong password for the first admin.
  - **`dsa-api` → `CORS_ORIGINS`** — put a placeholder for now, e.g. `https://placeholder`
    (you'll set the real value in step 4).
  - **`dsa-web` → `NEXT_PUBLIC_API_URL`** — put a placeholder, e.g. `https://placeholder`
    (you'll set the real value in step 4).
- Click **Apply**. Render creates the database and starts the first builds.

The JWT secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`) are generated automatically
by Render — you do not create them.

### 2. Database migration — runs automatically
`dsa-api`'s build command runs `prisma migrate deploy` before the app starts, so the
schema is created on the first deploy. `migrate deploy` is the production-safe,
non-interactive migration command and is idempotent, so it is a no-op on later deploys.

> Prefer a manual migration instead? Remove `npm run db:migrate -w @dsa/api` from the
> `dsa-api` build command in `render.yaml`, then run it once from the service Shell after
> the first deploy: `npm run db:migrate -w @dsa/api`.

### 3. Wait for `dsa-api` to go live, then copy its URL
- Open `dsa-api` → wait for **Live** and a green health check.
- Copy its URL, e.g. `https://dsa-api.onrender.com`.
- Note the frontend URL too (`dsa-web`), e.g. `https://dsa-web.onrender.com`.

### 4. Wire the two services together (manual)
- **`dsa-web` → Environment → `NEXT_PUBLIC_API_URL`** =
  `https://dsa-api.onrender.com/api/v1` (your API URL + `/api/v1`).
- **`dsa-api` → Environment → `CORS_ORIGINS`** = `https://dsa-web.onrender.com`
  (your frontend URL, no trailing slash).
- Save. Changing `CORS_ORIGINS` restarts the API automatically (it's read at runtime).
- **Manually redeploy `dsa-web`** (Manual Deploy → *Deploy latest commit*) so the new
  `NEXT_PUBLIC_API_URL` is compiled into the bundle. **This rebuild is required.**

### 5. Admin user — created automatically
`dsa-api`'s build runs the seed after the migration, so the admin account exists as soon
as the API is live. No manual step is required. The seed is production-aware: with
`NODE_ENV=production` it creates **only** the admin account, the default scoring formula,
and the LeetCode problem catalogue — the 60-student demo cohort and synthetic history are
**never** created in production. It is idempotent and never resets an existing admin's
password, so it is safe on every redeploy.

Sign in at the frontend with `SEED_ADMIN_EMAIL` / the `SEED_ADMIN_PASSWORD` you set in
step 1, then change the password from the UI.

> Need to re-run the seed later (e.g. to refresh the problem catalogue)? On a plan with
> Shell access: `dsa-api` → **Shell** → `npm run db:seed -w @dsa/api`.

### 6. Verify
- `https://dsa-api.onrender.com/api/v1/health` → `{"status":"ok",...}`
- `https://dsa-api.onrender.com/api/v1/health/ready` → database `up`.
- Frontend loads and login succeeds (open devtools; requests should go to your API URL,
  not `localhost`).
- Cron jobs: open `dsa-sync` → **Trigger Run** to confirm it completes. (With no students
  imported yet it exits cleanly with *"Sync did not start: No active students"* — that is
  success, not an error.)

### 7. Import students and run the first sync
- In the app, import the student list (Excel) or add students, giving each a real
  LeetCode username.
- Trigger a sync from the admin UI, or run `dsa-sync` manually. From then on the cron
  jobs keep it current.

---

## Seed data: production vs staging

| | Admin + scoring + problems | Demo cohort (60 students, 30 days) |
|---|---|---|
| **Production** (`NODE_ENV=production`) | Yes — seeded automatically in the API build. | Never. |
| **Staging / demo** | Yes | Yes, unless you set `SEED_DEMO=false`. |

To stand up a **staging** service that shows populated dashboards, create it with
`NODE_ENV` **not** set to `production` (or set `SEED_DEMO=true`) and run the seed — it
will generate the demo cohort.

---

## Custom domain (optional, manual)
1. `dsa-web` → **Settings → Custom Domains** → add your domain; create the CNAME it shows
   at your DNS provider.
2. (Optional) Do the same for `dsa-api` if you want the API on a subdomain.
3. Update **`dsa-api` `CORS_ORIGINS`** to include the new frontend origin.
4. Update **`dsa-web` `NEXT_PUBLIC_API_URL`** to the new API origin, then **redeploy
   `dsa-web`** (build-time value — rebuild required).

---

## Optional: Redis-backed queue (only if you scale the API out)
This blueprint uses the `inline` queue driver (no Redis) and the in-memory cache
fallback — correct for a single API instance. If you run **more than one** API instance,
add a Render Key Value (Redis) instance and set on `dsa-api`:
`QUEUE_DRIVER=bullmq` and `REDIS_URL=<the Key Value internal URL>`. Nothing else changes.

---

## Alternative: one always-on worker instead of cron jobs
If you'd rather run a single long-lived process that uses the app's built-in scheduler
(instead of the two cron jobs):
- Delete the `dsa-sync` and `dsa-rollup` services from `render.yaml`.
- Set `SYNC_ENABLED=true` on a **non-suspending** `dsa-api` instance (an always-on plan),
  and set `SYNC_CRON` / `ROLLUP_CRON` as desired (evaluated in `PROGRAM_TIMEZONE`).
The cron-job approach is the default here because it keeps working even when the web
service is idle-suspended.
