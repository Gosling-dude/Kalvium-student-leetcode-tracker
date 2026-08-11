# DSA Tracker

Automated LeetCode progress tracking for the Kalvium DSA mastery programme. Mentors
upload the student list once, post four problems a day, and press **Sync** — the
platform checks every student's submissions, scores them, and produces the daily
report, leaderboards and analytics on its own. **Email Reports** turns that daily
report into a mentor-approved email — who needs intervention today, and what to do
about it — see [docs/DAILY_EMAIL_REPORTING.md](docs/DAILY_EMAIL_REPORTING.md).

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

npm run db:seed:students        # optional: load the real roster (see below)

npm run dev                     # API on :4000, web on :3000
```

### Loading the real roster

`apps/api/prisma/roster.csv` holds the live cohort — one row per student, with the
columns the programme's spreadsheet already uses:

```
Full Name,Kalvium Email ID,Batch,Cohort,Max Belt Level,Squad,Leet code user name,Leet code profile link
```

`Batch` accepts a code (`A`, `B`) or a name (`Foundation`, `Intermediate`) and must name
a batch that already exists — the loader will not invent one from a typo. `Cohort` and
`Max Belt Level` are numbers; `Max Belt Level` is stored verbatim and is never derived
from score, solved counts or eligibility. The LeetCode columns are optional: a student
can be on the roster before their handle has been collected, and the sync skips them
until one is set rather than reporting a "user not found" that is not true.

> **`roster.csv` is gitignored and must stay that way.** It contains students' real
> names and email addresses, and this repository is public. `roster.example.csv` is the
> committed format reference — copy it to `roster.csv` and fill it in. When the file is
> absent the loader skips quietly, so a fresh clone and the deploy build both work
> without it.

The loader **synchronises** rather than merely inserting. Matching is on the normalised
email, so it is safe to re-run at any time:

| Roster says | Database says | Result |
| --- | --- | --- |
| present | missing | created |
| present | present | name, batch, cohort and belt updated in place |
| present | different batch | moved, and the change recorded in batch history |
| absent | present, with history | **archived** — hidden from every current view, every historical record kept |
| absent | present, no history at all | deleted |

Archiving is never deletion. A student who leaves the programme keeps their submissions,
daily results, streak history, leaderboard entries and email history; only their presence
in the current roster ends.

Update that file when the cohort changes and re-run the loader:

```bash
npm run db:seed:students -w @dsa/api -- --dry-run   # validate, write nothing
npm run db:seed:students -w @dsa/api               # apply
```

Students are matched on email, so re-running updates names, squads and handles in
place instead of creating duplicates. Squads are created inside `Batch 2026`
(override with `ROSTER_BATCH_NAME`), and the handle is derived from the profile link
when the username column is blank. Students who have dropped out of the sheet are
**reported, not deleted** — deleting one cascades away their whole submission mirror,
which LeetCode's 20-row window makes unrecoverable.

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
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` / `EMAIL_FROM` | Backend | ➖ | Enables the daily report email send. See [docs/DAILY_EMAIL_REPORTING.md](docs/DAILY_EMAIL_REPORTING.md). |

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
│           ├── email-reports/ daily report, blockers, approval-gated email
│           │                  → docs/DAILY_EMAIL_REPORTING.md
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
whole upload with one 400. Batches and squads named in the sheet are created on demand,
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
Squads are compared on averages, so a 12-person squad does not out-rank an 8-person one
on volume alone.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API and web together |
| `npm run build` | Build shared → API → web |
| `npm run typecheck` | Type-check all three packages |
| `npm test` | Unit tests |
| `npm run test:e2e -w @dsa/api` | Integration tests (needs `DATABASE_URL`) |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed admin, scoring formula, demo cohort |
| `npm run db:seed:students` | Synchronise the roster from `apps/api/prisma/roster.csv` (`-- --dry-run` to preview) |
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

Verified on this machine: **153 unit tests pass** (130 domain — including the daily
email reporting rules — 23 provider/rate-limiter); shared/API/web all type-check;
shared/API/web all build, including the new `/email-reports` route (11 routes total);
the Prisma schema validates and every migration's SQL (including
`20260811000000_daily_email_reporting`) is generated and diff-verified against the
schema; the new GitHub Action YAML parses; the live provider smoke test passes all
8 checks against LeetCode.

**Not yet exercised against a live database.** No local PostgreSQL/Docker was available
in the environment this was built in, so the new migration has not been applied and the
API has not been booted end-to-end — the same gap the previous status note here
described. Run `npm run db:migrate -w @dsa/api && npm run db:seed -w @dsa/api` (or
`docker compose up`), then exercise the full flow once — generate a report for today,
yesterday, and an older date; record a blocker; preview, approve and send an email
(with `EMAIL_PROVIDER=resend` configured) — before relying on this in production.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model and
[`docs/STATUS.md`](docs/STATUS.md) for a feature-by-feature completion breakdown.
