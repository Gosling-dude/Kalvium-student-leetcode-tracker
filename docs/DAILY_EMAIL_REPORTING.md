# Daily Email Reporting & Action-Item Automation

Answers one question for the campus/mentor team: **who needs intervention today, and
what should we do about it** — for any date, not just today.

## Feature overview

Every program day, mentors and admins can generate a report for that day showing:

- The problems assigned that day (dynamically read from `Assignment` — never assumed
  to be 4)
- Student-wise completion counts, grouped into buckets sized to that day's actual
  assignment count
- Action items per completion tier, with blocker-aware guidance
- A blocker summary distinguishing "no blocker reported" from "mentor confirmed there
  is no blocker"
- A student table with status, blocker, and the exact action a mentor should take
- An HTML email built from the same data, previewed and edited before it can be sent
- An approval gate: nothing is emailed until a signed-in mentor/admin clicks
  **Approve & Send**
- History of every generated report and its lifecycle

It is built entirely on the existing schema and services — `Student`, `Assignment`,
`Submission`, `DailyStatus`, `DashboardService`, `ReportsService`'s export machinery,
the existing auth/roles guards, and the `NotificationsService` abstraction. Two new
tables were added (`Blocker`, `EmailReport`); everything else is computed live. See
[Database changes](#database-changes) below.

Frontend: **Email Reports** in the sidebar (`apps/web/src/app/(app)/email-reports`).
Backend: `apps/api/src/modules/email-reports/`.

## Report calculation

`DailyReportService.build(dayKey)` (`apps/api/src/modules/email-reports/daily-report.service.ts`)
reuses `DashboardService.getMentorDashboard(dayKey)` — the same query the Mentor View
page reads — so this report can never disagree with the rest of the app about who
solved what. Nothing about a report is stored; it is recomputed from
`Assignment` + `DailyStatus` + `DailyProblemStatus` every time.

### Action tiers (generalised, not hardcoded to 4 problems)

The spec's worked example phrases the five action tiers as absolute solved-counts for a
4-problem day ("solved 0" / "1" / "2" / "3" / "all"). Generalised to `assignedCount`
problems, the only version of that rule that still makes sense is by problems
**remaining**, not solved, except at the two extremes:

| Condition                          | Tier            | Emoji |
| ----------------------------------- | ---------------- | ----- |
| `assignedCount == 0`               | Not assigned     | ⚪    |
| `solved == 0`                      | Urgent           | 🔴    |
| `remaining >= 3`                   | Intervention     | 🟠    |
| `remaining == 2`                   | Follow-up        | 🟡    |
| `remaining == 1`                   | Near completion  | 🟢    |
| `solved == assignedCount`          | Complete         | ✅    |

For `assignedCount === 4` this reduces to exactly the spec's worked example. For a
3-problem day it produces 4 tiers instead of 5 (there is no "3 remaining" state when
only 3 were assigned) — see `actionTierFor` in
`packages/shared/src/domain/daily-email-report.ts`, fully unit-tested in the sibling
`.spec.ts`.

Performance buckets ("Completed All / 3 / 2 / 1 / 0") are sized to
`assignedCount + 1` buckets, `assignedCount` down to `0` — a 3-problem day never shows
a "Completed 4" group (`buildBucketShapes`).

### Solved count

"Solved" is always **distinct assigned problems with an accepted submission**, read
from `DailyStatus.solvedCount` — the same rollup used everywhere else in the app.
Duplicate submissions of the same problem, or submissions of a problem before it was
assigned, never inflate this number; that logic lives in `RollupService` and is not
duplicated here.

## Historical reports

Every report is date-based and reconstructed from stored data — see
`schema.prisma`'s `dayKey` design notes. Selecting **07 Aug 2026** queries
`Assignment`/`DailyStatus` rows for `dayKey = '2026-08-07'`, never "today". Day
boundaries resolve in `PROGRAM_TIMEZONE` (`Asia/Kolkata` by default) via
`ProgramTimeService`, exactly like the rest of the app.

Edge cases handled explicitly by `DailyReportService`:

- **Future date** → `isFutureDate: true`, no computation is attempted, the UI shows
  "No assignment data available for this date."
- **No assignment that day** → `hasAssignment: false`, empty report with a clear
  empty state.
- **No students tracked** → valid report, `studentsTracked: 0`.
- **Student joined after this program day** → excluded from the report and counted in
  `excludedNotYetEnrolled`, so a historical report reflects who was actually enrolled
  at the time.
- **Missing LeetCode profile / private profile / failed sync** → surfaced via the
  existing `syncStatus`/`reason` fields (unchanged from the mentor dashboard) rather
  than silently shown as a real zero.

## Blockers

`Blocker` (one row per student per day — `@@unique([studentId, dayKey])`) records why a
student did not finish, distinct from a student simply not having been asked yet:

- **No `Blocker` row** → the report/email says "No blocker reported."
- **`Blocker` row with `category = NO_BLOCKER`** → "No blocker reported — student
  should complete the remaining assignments" (a mentor explicitly confirmed there is
  no blocker).
- **`Blocker` row with any other category** → the category and free-text description
  are surfaced directly in the action text (`buildActionRequiredText`, fully tested).

`solvedCount`/`assignedCount` on a `Blocker` are a snapshot taken from `DailyStatus` at
the moment it is recorded — never trusted from client input — so the record reads
correctly even if a later sync changes the live numbers.

Record or edit a blocker from the student table's **Record blocker** action, or via
`POST /api/v1/reports/blockers` / `PATCH /api/v1/reports/blockers/:id`.

## Email configuration

`EmailService` (`apps/api/src/infra/email/`) is a small transport abstraction:

```
EmailTransport { provider, send(email) }
ResendTransport implements EmailTransport   // https://resend.com — free tier, no SMTP
```

Nothing provider-specific is visible outside `infra/email` — swapping providers means
writing one class and changing `email.service.ts`'s `resolveTransport()`. With no
provider configured, previews/drafts/approvals all work; only the final send is
refused, with `EmailProviderNotConfiguredError` naming exactly what to set.

### Environment variables

| Variable            | Required | Purpose                                                        |
| -------------------- | -------- | ---------------------------------------------------------------- |
| `EMAIL_PROVIDER`     | for send | `resend` or `none` (default)                                     |
| `EMAIL_API_KEY`      | for send | Resend API key                                                   |
| `EMAIL_FROM`         | for send | Sender address, must be on a domain verified with the provider   |
| `EMAIL_DEFAULT_TO`   | for automation | Comma-separated default "to" list the daily GitHub Action uses |
| `EMAIL_DEFAULT_CC`   | optional | Comma-separated default "cc" list for automation                 |

Sending happens **server-side only** — the API key never reaches the frontend. Every
send is role-gated (`ADMIN`/`MENTOR`) and rate-limited (`5/min`) on top of the app's
global throttle.

## Approval workflow

`EmailReport.status`: `DRAFT → PENDING_APPROVAL → APPROVED → SENT` (or `FAILED`).

1. **Generate** (`POST /reports/daily/:date/generate-email`) renders the report as an
   email and saves it `DRAFT`.
2. **Preview / Edit** (`POST /reports/email/preview`) re-renders with edited
   recipients/subject, persisting the edit — locked once `APPROVED` or `SENT`.
3. **Approve** (`POST /reports/email/approve`) — the gate. Only a signed-in
   ADMIN/MENTOR can call this.
4. **Send** (`POST /reports/email/send`) is the *only* method that calls
   `EmailService.sendEmail`, and it refuses anything that is not `APPROVED` (or a
   `FAILED` retry). This is enforced in `EmailReportsService.send`, not in the UI —
   there is no way to reach the transport by skipping a step, including from
   automation.

**Duplicate-send protection:** before sending, the service checks for an existing
`SENT` report for the same `dayKey`. If one exists, the request is rejected with
"This report has already been sent" unless the caller explicitly passes `force: true`
(the UI's **Send Again** confirmation) — see `EmailReportsService.send`.

## Daily automation

`.github/workflows/daily-report.yml`, scheduled 20 minutes after `rollup.yml` (so
`DailyStatus` for the closed day is final), `POST`s to
`/api/v1/internal/daily-report` — the same `CronSecretGuard` pattern as
`/internal/sync` and `/internal/rollup`. It:

1. Resolves the program day that just closed (`yesterday`, or an explicit `dayKey`
   input for a manual `workflow_dispatch` run)
2. Generates the report and email (`EmailReportsService.generateDraft`)
3. Marks it `PENDING_APPROVAL` (`EmailReportsService.submitForApproval`) — **never**
   `APPROVED` or `SENT`
4. Dispatches a `DAILY_REPORT_PENDING_APPROVAL` event through the existing
   `NotificationsService` (Slack/Discord, if configured) so the team knows one is
   waiting
5. A human opens **Email Reports**, reviews the draft, and clicks **Approve & Send**

If `EMAIL_FROM` or `EMAIL_DEFAULT_TO` are not configured, the run logs a warning and
skips — it does not fail loudly for what is an expected pre-configuration state, and it
never falls back to sending without recipients.

### GitHub Actions secrets

Same two secrets as `sync.yml`/`rollup.yml`: `BACKEND_URL`, `CRON_SECRET`.

## Database changes

Purely additive migration
(`apps/api/prisma/migrations/20260811000000_daily_email_reporting/`):

- `BlockerCategory`, `EmailReportStatus` enums
- One new value on the existing `NotificationEvent` enum:
  `DAILY_REPORT_PENDING_APPROVAL`
- `Blocker` table
- `EmailReport` table (this **is** the email history — no separate log table; a row's
  `status` transitions through its lifecycle and is never re-derived)

No existing table, column, or constraint is altered. There is deliberately no
`DailyReport` table — every number is reconstructable from `Assignment` +
`DailyStatus`, exactly like the rest of the app's aggregates.

## API endpoints

All under `/api/v1/reports`, role-gated to `ADMIN`/`MENTOR`:

```
GET    /reports/daily/:date                  full report
GET    /reports/daily/:date/summary          summary card numbers only
GET    /reports/daily/:date/students          student table (optional ?tier=)
GET    /reports/daily/:date/export            CSV/XLSX download
POST   /reports/daily/:date/generate-email    render + save as DRAFT
POST   /reports/email/preview                 re-render an edited draft
POST   /reports/email/approve                 approval gate
POST   /reports/email/send                    the only route that sends
GET    /reports/email/history                 paginated history
GET    /reports/email/status?dayKey=          sent/latest for a day (dup-send UI)
GET    /reports/email/:id                     view one historical email
POST   /reports/blockers                      record/update a blocker
PATCH  /reports/blockers/:id                  update a blocker
GET    /reports/blockers                      list (optional ?dayKey=&studentId=)
```

Internal (GitHub Actions only, `CronSecretGuard`):

```
POST   /internal/daily-report                 { dayKey? } — generates + PENDING_APPROVAL
```

Note: `GET /reports/daily` (no path param, `?dayKey=` query) already existed for the
CSV/XLSX exports used elsewhere in the app and is unchanged — the new report lives
under `/reports/daily/:date` (path param) specifically to avoid colliding with it.

## Troubleshooting

**"No email provider is configured"** when clicking Approve & Send — set
`EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, and `EMAIL_FROM`, then redeploy the API.
Preview/approve still work with none of this set; only the transport call fails.

**"This report has already been sent"** — expected duplicate-send protection. Use
**View Previous Email** to see what went out, or confirm **Send Again** if you
genuinely mean to resend.

**A date shows "No assignment data available"** — either the date is in the future, or
no `Assignment` row exists for that `dayKey`. Check the Assignments page for that date.

**The daily automation didn't run / nothing showed up as PENDING_APPROVAL** — check the
`Daily Report Generation` GitHub Action run log. The most common cause is
`EMAIL_FROM`/`EMAIL_DEFAULT_TO` not being set as repo secrets or API env vars, in which
case the run intentionally skips (see [Daily automation](#daily-automation)).

**Numbers in a sent email don't match today's dashboard** — expected. A `SENT`
`EmailReport` stores exactly what was rendered at send time (`bodyHtml`, `snapshot`);
it is never rewritten by later syncs, so "View Previous Email" always shows what
recipients actually received.
