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

## Resolved: production deploys again

Production is serving the current commit. The push-to-serving lag measured on 27 Aug was
about three minutes, not the 30–70 the earlier note recorded, so the smoke test's
"deployed commit is a descendant of / equal to this one" check now passes on the push
itself rather than only on the schedule.

## Known gaps in production

- **Alliance’s 46 students have no email address, so none of them can log in.** The
  roster they were imported from carries no email column, and the existing addresses give
  no rule that would reconstruct one safely: three name conventions and two squad formats
  are in use (`first.last.s.NNN`, `first.initial.sNN`, `last.first.sNN`; `s69` and `s.69`).
  A wrong guess creates a student who can never log in and who a later correct import
  duplicates rather than updates, so no addresses were invented. They are tracked, synced
  and reported on in full — only the *portal login* is blocked. Supply an Email column and
  re-run the import to close it. SRM (99) and VELS (31) all have addresses and accounts.
- **One Alliance student has no LeetCode handle.** TIPPU DAVALASAB GHORPADE’s roster entry
  is `leetcode.com/profile/`, a generic page carrying no handle, so he syncs as
  `PROFILE_MISSING` — which reads as “nobody has collected a handle yet” rather than as a
  failed read, and is deliberately not the same thing as “solved 0”.
- **Alliance has no assignment and no baseline test.** All 18 assignments and both baseline
  tests are scoped to SRM or VELS. Alliance students therefore show no assignment progress
  because there is nothing assigned to them, not because the calculation is wrong. Creating
  either means choosing real problems, which is a programme decision, not one this repo can
  make up.
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
  server-side on the student directory, the campus/batch student routes, and — since the
  reporting endpoints were found unscoped — the mentor tracker, dashboard, leaderboard,
  reports and email-report reads. Every one resolves through
  `CampusesService.resolveScopeFor`, which takes the caller, so the check cannot be
  forgotten at a call site. A mentor naming no campus is pinned to their grant rather than
  widened to the whole programme. "Not yours" and "does not exist" are answered identically
  so ids cannot be used to enumerate.
- **Mentor management** — admins add mentors, change a mentor's campus, reset a password
  and deactivate/reactivate an account from the Admin screen, with no database access. A
  campus can hold any number of mentors. Deactivation is soft and revokes live sessions
  immediately; nothing deletes a user, because the audit rows recording what they did
  reference them.
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
