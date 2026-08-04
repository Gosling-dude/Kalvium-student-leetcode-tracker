# DSA Tracker

Automated LeetCode progress tracking for the Kalvium DSA mastery programme. Mentors
upload the student list once, post four problems a day, and press **Sync** — the
platform checks every student's submissions, scores them, and produces the daily
report, leaderboards and analytics on its own.

---

## The most important thing to know before you deploy this

**LeetCode has no official API for submission history, and the public endpoint returns
only the 20 most recent submissions per user.**

That is not an assumption — it was measured against the live endpoint while this was
being built. Requesting 100 results returned 20; requesting 500 also returned 20.

Three consequences shape the entire design, and you should understand them before
relying on the reports:

1. **Sync must run several times a day, not once.** A student who solves more than 20
   problems between two syncs will have submissions that we can never see. The default
   `SYNC_CRON` is every three hours for exactly this reason. Setting it to daily will
   silently lose data for your most active students.
2. **History cannot be backfilled.** Anything older than the 20-item window is
   unreachable. This is why every submission we ever observe is written to a permanent
   local mirror and never re-derived from the API — streaks, weekly and monthly reports
   all read from that mirror.
3. **Runtime and memory are not available.** The public queries expose submission id,
   title, slug, timestamp, status and language — nothing more. Those columns exist in
   the schema and are nullable; they are never populated with invented values.

If LeetCode changes or blocks this endpoint, the fix is confined to **one class**
(`apps/api/src/modules/providers/leetcode/leetcode.provider.ts`). Nothing else in the
codebase knows LeetCode exists.

---

## Quick start

### With Docker (recommended)

```bash
cp .env.example .env

# Generate real secrets — the API refuses to start in production with placeholders.
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(48).toString('base64url'))" >> .env
node -e "console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(48).toString('base64url'))" >> .env

docker compose up -d
```

- Web client — <http://localhost:3000>
- API + Swagger — <http://localhost:4000/api/v1/docs>

Migrations run and the database seeds automatically on first boot. Sign in with
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from your `.env`, then **change the
password immediately**.

### Without Docker

Requires Node 20+ and a reachable PostgreSQL. Redis is optional — see
[Running without Redis](#running-without-redis).

```bash
npm install
npm run build:shared            # the domain package must be built first

# Point DATABASE_URL at your database
cp .env.example apps/api/.env   # then edit DATABASE_URL

npm run db:migrate -w @dsa/api  # or: npx prisma migrate dev
npm run db:seed -w @dsa/api

npm run dev                     # API on :4000, web on :3000
```

---

## Verifying the LeetCode integration

```bash
npm run smoke:provider -w @dsa/api
```

This hits the real endpoint and asserts the behaviour the system depends on — the
20-row cap, newest-first ordering, the incremental cursor, and that an unknown username
raises `USER_NOT_FOUND` rather than silently reading as "solved 0". Run it if the
numbers ever look wrong; it will tell you within seconds whether LeetCode changed
something.

---

## Deployment — a fully free stack ($0)

The app deploys across free tiers, with no paid infrastructure:

| Layer | Platform | Guide |
|---|---|---|
| Frontend (Next.js) | **Vercel** (Free) | [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md) |
| Backend (NestJS) | **Render** Free Web Service | [docs/DEPLOY_RENDER_FREE.md](docs/DEPLOY_RENDER_FREE.md) |
| Database | **Neon** PostgreSQL (Free) | [docs/DEPLOY_NEON.md](docs/DEPLOY_NEON.md) |
| Scheduled sync / rollup | **GitHub Actions** → internal HTTP endpoints | `.github/workflows/` |
| Repo & CI | **GitHub** | — |

**How the schedule works without a paid cron:** a Free Web Service can be suspended when
idle, so the schedule lives in GitHub Actions. On cron, they `POST` to the backend's
internal endpoints — `/api/v1/internal/sync` (every 3h) and `/api/v1/internal/rollup`
(nightly) — authenticated with `Authorization: Bearer <CRON_SECRET>`. The in-process
scheduler is turned off in production (`SYNC_ENABLED=false`) so work never runs twice.

Deploy order: **Neon → Render (backend) → set `CORS_ORIGINS` → Vercel (frontend) → GitHub
Secrets**. Two build-time gotchas: `NEXT_PUBLIC_API_URL` is baked into the frontend at
build (redeploy Vercel if it changes), and **never set `PORT`** (Render injects it).

### Environment variables

| Variable | Where | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | Backend | ✅ | Neon PostgreSQL connection string (pooled, `sslmode=require`). |
| `NEXT_PUBLIC_API_URL` | Frontend (Vercel) | ✅ | Backend base URL incl. prefix, e.g. `https://api.onrender.com/api/v1`. Build-time. |
| `JWT_ACCESS_SECRET` | Backend | ✅ | ≥32 chars, random. Signs access tokens. |
| `JWT_REFRESH_SECRET` | Backend | ✅ | ≥32 chars, random, **different** from the access secret. |
| `CRON_SECRET` | Backend **and** GitHub | ✅ | Shared bearer secret for the internal cron endpoints. Must match. |
| `CORS_ORIGINS` | Backend | ✅ | Comma-separated allowed origins, e.g. the Vercel URL. |
| `NODE_ENV` | Backend | ✅ | `production`. |
| `PORT` | Backend | ⛔ | **Do not set** — Render injects it; the app reads it. |
| `SYNC_ENABLED` | Backend | ✅ | `false` in production (GitHub Actions drive the schedule). |
| `QUEUE_DRIVER` | Backend | ✅ | `inline` (no Redis on the free stack). |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Backend | ✅ | First admin; change the password after first login. |
| `PROGRAM_TIMEZONE` | Backend | ✅ | e.g. `Asia/Kolkata`. All day boundaries resolve here. |
| `SWAGGER_ENABLED` | Backend | ➖ | `false` by default in production; `true` to expose `/api/v1/docs`. |

GitHub Actions secrets (Repo → Settings → Secrets and variables → Actions): `BACKEND_URL`
(the Render base URL, no `/api/v1`) and `CRON_SECRET` (same value as the backend).
See [.env.example](.env.example) for the complete local list.

---

## Architecture

```
dsa-tracker/
├── packages/shared/        Pure domain logic — no I/O, no framework
│   └── src/domain/         time · scoring · streaks · ranking · gamification
├── apps/api/               NestJS + Prisma + BullMQ
│   ├── prisma/             schema, migration, seed
│   └── src/
│       ├── config/         typed, validated configuration
│       ├── common/         guards · filters · interceptors · ProgramTimeService
│       ├── infra/          Prisma · cache (Redis with in-memory fallback)
│       └── modules/
│           ├── providers/  ← the ONLY code that knows about LeetCode
│           ├── sync/       incremental sync, queue, scheduler
│           ├── scoring/    scoring config + the rollup engine
│           └── …           auth · students · assignments · dashboard ·
│                             leaderboard · analytics · reports · admin ·
│                             notifications · audit · health
└── apps/web/               Next.js 15 · TanStack Query/Table · Recharts
```

Full detail, including the data-flow and the derived-state model, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Two ideas that carry most of the weight

**Everything is derived from two stored facts.** The submission mirror and the
assignment list are the source of truth. Daily status, streaks, scores, leaderboards
and badges are all *caches* that `RollupService` can rebuild at any time. That is what
makes an admin-editable scoring formula safe: change the weights, press **Recalculate
scores**, and all of history is re-scored from stored data without contacting LeetCode
again.

**One place owns the calendar.** Every day boundary — "today", streak continuity,
completion time, weekly percentages — resolves through `ProgramTimeService` in a single
configured timezone (`PROGRAM_TIMEZONE`, default `Asia/Kolkata`). A submission at 23:50
IST belongs to a different day depending on whether you ask UTC or the server's locale,
and streak bugs from that are invisible until a mentor complains.

---

## Notable behaviours

### Every zero is explainable

At 250 students, misspelled usernames are a certainty. If those students simply showed
"Solved 0", mentors would read it as laziness. Instead each student carries a sync
status (`OK`, `USER_NOT_FOUND`, `PROFILE_PRIVATE`, `RATE_LIMITED`, `TIMEOUT`,
`PROVIDER_ERROR`), the "Solved 0" table shows the reason per row, and the dashboard
raises a banner counting students whose data could not be trusted this cycle.

### Import reports failures per row

A 250-row spreadsheet is never clean. The importer creates the valid rows and returns a
per-row error list — row number, field, and what was wrong — instead of failing the
whole upload with one 400. Batches and groups named in the sheet are created on demand,
and a pasted profile URL is accepted where a username was expected.

### Running without Redis

`QUEUE_DRIVER=inline` runs sync jobs in-process, and the cache falls back to an
in-memory LRU automatically if Redis is unreachable. This makes the platform fully
operable with Postgres alone.

The trade-off is stated plainly: inline jobs do not survive a restart and cannot spread
across replicas. Use `bullmq` (the default) for anything beyond a single instance.

---

## Scoring

Solving *n* of the day's problems scores `n × 25`, so the canonical table holds:
4 → 100, 3 → 75, 2 → 50, 1 → 25, 0 → 0. On top of that sit difficulty weighting,
tiered early-completion bonuses, a capped streak bonus, and weekly/monthly consistency
and perfect-period bonuses.

The formula is **data, not code** — stored as a `ScoringConfig` row, edited from the
admin panel, versioned, and read at compute time. Every score also carries a labelled
breakdown so a student can be told exactly why they scored what they did.

Leaderboards rank by score, then problems solved, then **earliest completion time**
(the specified tiebreaker), then streak, then consistency. Ties share a rank.
Groups are compared on averages, so a 12-person group does not out-rank an 8-person one
on volume alone.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API and web together |
| `npm run build` | Build shared → API → web |
| `npm run typecheck` | Type-check all three packages |
| `npm test` | Unit tests |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed admin, scoring formula, demo cohort |
| `npm run db:studio` | Prisma Studio |
| `npm run smoke:provider -w @dsa/api` | Live LeetCode contract check |

---

## Security

JWT authentication implemented in-house rather than a hosted provider, so the stack
needs no external account and `docker compose up` is genuinely one command. Refresh
tokens are stored hashed and rotated on use; reuse of a revoked token revokes every
session for that user. Authentication is applied globally and opted out of per route,
so a newly added endpoint is protected by default. Also: role-based authorization with
implicit admin, Helmet, CORS allow-list, global and per-route rate limiting,
`whitelist`+`forbidNonWhitelisted` validation on every DTO, parameterised queries
throughout via Prisma, and an audit log of every mutating action.

**Before any real deployment:** set both JWT secrets, change the seeded admin password,
and set `CORS_ORIGINS` to your actual origin.

---

## Status

Verified on this machine: **126 unit tests pass** (103 domain, 23 provider/rate-limiter);
API type-checks and builds; web type-checks and builds all 9 routes; the Prisma schema
validates and its migration SQL is generated; the live provider smoke test passes all
8 checks against LeetCode.

**Not yet exercised against a live database.** The migration has not been applied and
the API has not been booted end-to-end, because the local PostgreSQL uses
`scram-sha-256` and no password was available during the build. Run
`npm run db:migrate -w @dsa/api && npm run db:seed -w @dsa/api` (or `docker compose up`)
to close that gap — that is the first thing to do.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model and
[`docs/STATUS.md`](docs/STATUS.md) for a feature-by-feature completion breakdown.
