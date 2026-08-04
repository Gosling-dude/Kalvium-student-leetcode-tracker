# Status

An honest, feature-by-feature account of what is finished, what is thinner than the
brief asked for, and what has not been exercised.

## Verified on the build machine

| Check | Result |
|---|---|
| `packages/shared` build | pass |
| `packages/shared` unit tests | **103 passed** (5 files) |
| `apps/api` unit tests | **23 passed** (rate limiter, retry policy, provider contract) |
| `apps/api` type-check (`src` + `prisma` + `scripts`) | pass |
| `apps/api` build (`nest build` → `dist/main.js`) | pass |
| `apps/web` type-check | pass |
| `apps/web` build | pass — 9 routes |
| `prisma validate` | pass |
| Migration SQL generated (`20260804000000_init`) | 575 lines |
| Live LeetCode provider smoke test | **8/8 checks pass** |

## Not verified

**The API has never been booted against a live database, and the migration has not been
applied.** The local PostgreSQL 18 on this machine uses `scram-sha-256` and no password
was available, so every database interaction is unexercised: migration apply, seed,
sync end-to-end, and all query paths.

The schema validates and the migration SQL is generated, but "compiles and validates" is
not "runs". Treat the first `docker compose up` (or `npm run db:migrate && npm run
db:seed`) as the real acceptance test.

Also unexercised: the Docker images have not been built (Docker is not installed here),
and BullMQ's Redis path has not run (Redis is not installed here — the `inline` driver
exists partly for this reason).

## Complete

- **Domain core** — timezone-correct day bucketing, scoring with configurable weights
  and bonus tiers, streaks (daily/weekly/monthly, longest, break detection), competition
  ranking with the earliest-completion tiebreak, group aggregation, XP/levels,
  13 achievements, heatmap intensity. Fully unit-tested.
- **Provider abstraction** — interface, typed error taxonomy, token-bucket rate limiter
  with bounded concurrency, exponential backoff with full jitter, LeetCode
  implementation, and a fake that reproduces the real failure modes.
- **Database schema** — 24 models with the idempotency constraints the sync depends on.
- **Sync engine** — incremental cursor, bounded concurrency, per-student status and
  reason codes, retry-failed that skips permanently-broken usernames, live progress,
  queue health, cron scheduling in the program timezone, BullMQ + inline drivers.
- **Rollup engine** — rebuilds daily status, per-problem outcomes, streaks, scores,
  student aggregates and both leaderboards from stored facts; honours manual overrides.
- **Auth** — JWT with rotating hashed refresh tokens, reuse detection, global
  authenticate-by-default, role guard, password policy, session revocation.
- **Students** — CRUD, search, filters, pagination, bulk update/delete, mentor notes,
  Excel import with per-row error reporting, template download.
- **Assignments** — create/update/delete, automatic problem metadata fetch, URL preview,
  history.
- **Dashboard & mentor view** — every headline statistic in the brief, the five
  "solved N" tables with missing questions and a real reason for every zero.
- **Leaderboards** — student and group, daily/weekly/monthly, badges, rank deltas, ties.
- **Analytics** — daily/weekly/monthly trends, difficulty and topic breakdowns, group
  comparison, top improvers, bottom performers, heatmap endpoint. Charts use a palette
  validated for colour-vision deficiency against this app's own light and dark surfaces.
- **Reports & export** — daily, weekly, monthly, group, attendance; CSV, XLSX, PDF, JSON.
- **Admin** — batches, groups, mentor list, scoring formula versioning/activation,
  recompute, leaderboard reset, cache flush, settings, audit and system logs.
- **Frontend** — 9 routes, dark mode, command palette (⌘K), skeletons, empty and error
  states, toasts, responsive tables, accessible focus and progress semantics.
- **Ops** — Dockerfiles, compose with health checks, `.env.example`, Swagger, health and
  readiness probes.

## Thinner than the brief asked for

- **Auth provider.** Built in-house rather than Clerk/Auth.js. Deliberate — it removes
  an external dependency and keeps `docker compose up` a genuine one-command start while
  still satisfying authentication, authorization and audit. Flagged rather than hidden.
- **Notifications.** The abstraction, channel configuration, event routing and delivery
  logging are implemented, and Slack/Discord work through a generic webhook transport.
  Email, WhatsApp and Telegram have no transport class yet — the `/notifications/channels`
  endpoint reports which are actually implemented rather than implying all five work.
- **Student profile page.** The API returns the full profile (level, achievements,
  heatmap, recent history, notes); the frontend links to `/students/[id]` but that route
  is not built. This is the largest frontend gap.
- **Tests.** The domain core and the provider layer are covered (126 tests). API
  integration and E2E tests are not written — they need a live database, which was the
  blocker described above.
- **Company tags.** Verified premium-gated: the public endpoint returns `null`. The
  column exists and stays empty rather than being filled with invented data.
- **Runtime / memory per submission.** Not exposed by the public endpoints. Nullable
  columns, never fabricated.
- **Calendar view, search history, API-key management UI, bulk-edit UI.** API-side
  support exists for some (API keys are modelled); the dedicated UI screens are not
  built.

## Recommended first steps

1. Apply the migration and seed: `docker compose up -d`, or set `DATABASE_URL` and run
   `npm run db:migrate -w @dsa/api && npm run db:seed -w @dsa/api`.
2. Change the seeded admin password and set both JWT secrets.
3. Import a small real cohort (5–10 students) and press **Sync**. Check the
   "Solved 0" table — any `USER_NOT_FOUND` rows are import typos, and finding them early
   is much cheaper than discovering them in week three.
4. Confirm `SYNC_CRON` runs at least every few hours. Read the 20-row explanation in the
   README before changing it.
