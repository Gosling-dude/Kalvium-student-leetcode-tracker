# Status

An honest, feature-by-feature account of what is finished, what is thinner than the
brief asked for, and what has not been exercised.

## Verified

| Check | Result |
|---|---|
| `packages/shared` unit tests | **312 passed** (12 files) |
| `apps/api` unit tests | **295 passed** (21 files) |
| `apps/api` integration tests (real Postgres) | **102 passed** (9 files) |
| Type-check (`shared` + `api` + `web`) | pass |
| `apps/api` build (`nest build` → `dist/main.js`) | pass |
| `apps/web` build | pass |
| Live LeetCode provider smoke test | **8/8 checks pass** against leetcode.com |
| API booted against Postgres, exercised over HTTP | pass |
| Production: sync, rollup, report generation, integrity | pass |

The integration suites need a real database (`DATABASE_URL`) because what they verify *is*
database behaviour — composite uniqueness, cascade rules, frozen historical placement, and
that a failed sync does not rewrite stored results. They are kept out of `npm test` so the
unit suite stays fast and database-free; run them with `npm run test:e2e -w @dsa/api`.

## Verified in production

The system is live and serving a real cohort. Verified against the deployment, not just
the build:

- **Sync** — the 3-hourly GitHub Action completes against 130 students, ~113 reading
  successfully, with real submissions mirrored.
- **Rollup** — the nightly Action recomputes the closed day and prunes expired tokens.
- **Auth** — protected endpoints refuse anonymous callers; verified across seven of them
  on every push by the Production Smoke Test workflow.
- **Data integrity** — `GET /internal/integrity` reports six should-be-zero invariants
  from the live database, all zero, asserted on every push.

## Blocked: production has stopped deploying

**Production is serving `90d8db6` and has not taken a new commit since 09:45 UTC.** Three
commits are queued behind it. Everything below was ruled out as the cause:

| Check | Result |
|---|---|
| `npm ci` clean install | passes |
| The container's exact build sequence | passes, `dist/main.js` produced |
| `prisma migrate deploy` from an **empty** database | all 20 migrations apply |
| Boot from a clean build | health 200, database up, zero error lines |
| Nest module cycle | none |
| Typecheck, 731 tests | pass |

The commit is deployable and production itself is healthy — the scheduled sync succeeded
against 130 students on the old build, so `BACKEND_URL` and `CRON_SECRET` are valid.

**What cannot be determined from here:** whether the deploy is failing on the host, whether
auto-deploy is switched off, or whether the free tier's build minutes are exhausted. There
is no Render API key, CLI, credential file or `render.yaml` in this repository or
environment. Open the service's **Events** tab in the Render dashboard: it shows whether a
deploy for the queued commit was triggered at all, and if so what its build log says. That
one screen separates the three possibilities.

Nothing else unblocks it. The import needs the schema migration that ships in the queued
commit — production's `students.email` is still `NOT NULL`, so the 78 emailless students
cannot be stored there until it deploys. There is no deploy hook and no database credential
available as an alternative route.

## Known gaps in production

- **78 new students are prepared but not imported.** Squads 69/70/71/112. Every row is
  blocked on a missing email address, and the existing roster gives no rule that would
  derive one safely (three name conventions, two squad formats). No addresses were
  invented. See `tmp/import/README.md` for the prepared file, the live profile-validation
  results and the steps.
- **The nightly report generates nothing.** `EMAIL_FROM` and `EMAIL_DEFAULT_TO` are not
  set on the server, so the Daily Report Generation workflow runs and produces no reports.
  This was previously silent — the endpoint answered HTTP 200 with an empty result and the
  workflow showed a green tick. It now fails loudly and the integrity check flags it. Fix
  by setting both variables; nothing else is required to generate and queue a report.
  *Sending* an approved report additionally needs `EMAIL_PROVIDER` and `EMAIL_API_KEY`.

## Complete

- **Domain core** — timezone-correct day bucketing, scoring with configurable weights
  and bonus tiers, streaks (daily/weekly/monthly, longest, break detection), competition
  ranking with the earliest-completion tiebreak, squad aggregation, XP/levels,
  13 achievements, heatmap intensity. Fully unit-tested.
- **Provider abstraction** — interface, typed error taxonomy, token-bucket rate limiter
  with bounded concurrency, exponential backoff with full jitter, LeetCode
  implementation, and a fake that reproduces the real failure modes.
- **Database schema** — 25 models with the idempotency constraints the sync depends on.
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
- **Leaderboards** — student and squad, daily/weekly/monthly, badges, rank deltas, ties.
- **Baseline tests** — a separate assessment feature with its own tables and no handle on
  scoring or leaderboards, so a baseline score can never reach a streak or a daily rank.
  Student-wise leaderboard with competition ranking, search, squad and participation
  filters, per-question breakdown, and CSV/XLSX export. Every eligible student appears,
  including those who never started. Historical results are immutable: solving a problem
  after a test closes does not raise the recorded score.
- **Access control** — mentors are scoped to the campuses they are granted, enforced
  server-side on the student directory and the campus/batch student routes. "Not yours"
  and "does not exist" are answered identically so ids cannot be used to enumerate.
- **Forced password change** — enforced by a global guard rather than the UI, so an account
  still on its handed-over password can reach the change-password form and nothing else.
  This is what makes the optional shared `SEED_STUDENT_PASSWORD` safe.
- **Analytics** — daily/weekly/monthly trends, difficulty and topic breakdowns, squad
  comparison, top improvers, bottom performers, heatmap endpoint. Charts use a palette
  validated for colour-vision deficiency against this app's own light and dark surfaces.
- **Reports & export** — daily, weekly, monthly, squad, attendance; CSV, XLSX, PDF, JSON.
- **Admin** — batches, squads, mentor list, scoring formula versioning/activation,
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
- **Recompute is fire-and-forget.** `POST /admin/recompute` returns `202` immediately and
  runs in the background, because at 250 students × 30 days it is tens of thousands of
  writes and cannot complete inside an HTTP request. Unlike `POST /sync` it has no job
  row, so progress is not trackable — watch the system log for the completion entry.
  Giving it a `SyncJob`-style record is the natural next improvement.
- **Tests.** The domain core, provider layer, services and guards are covered by 607 unit
  tests, and 102 integration tests run against a real Postgres. What is still absent is
  browser-level E2E: the frontend has been verified by hand, not by an automated suite.
- **Company tags.** Verified premium-gated: the public endpoint returns `null`. The
  column exists and stays empty rather than being filled with invented data.
- **Runtime / memory per submission.** Not exposed by the public endpoints. Nullable
  columns, never fabricated.
- **Calendar view, search history, API-key management UI, bulk-edit UI.** API-side
  support exists for some (API keys are modelled); the dedicated UI screens are not
  built.

## Recommended first steps

The system is already deployed and syncing. The outstanding actions are:

1. **Set `EMAIL_FROM` and `EMAIL_DEFAULT_TO`** on the backend so the nightly report
   generates. Add `EMAIL_PROVIDER` and `EMAIL_API_KEY` to enable sending an approved one.
2. **Grant each mentor their campuses** via `PUT /admin/mentors/:id/campuses`. Existing
   mentors were granted every campus by the migration, so nobody lost access — narrowing
   them is a deliberate choice.
3. **Decide on `SEED_STUDENT_PASSWORD`** before provisioning student logins. Leave it unset
   for per-student random passwords, or set one shared value to read out to a cohort.
4. Watch the **Production Smoke Test** workflow. It fails on any non-zero data-integrity
   invariant, so a red run names the problem rather than needing to be investigated.
