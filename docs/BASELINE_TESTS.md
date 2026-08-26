# Baseline tests

Weekly assessments of whether a student can solve a problem **unaided**. A separate
feature from daily assignments, in every sense that matters.

## Why it is separate

A daily assignment measures practice and consistency: it feeds `DailyStatus`, the streak,
the daily score and every leaderboard built on them. A baseline test measures capability at
a point in time. If a baseline result could raise a completion percentage or extend a
streak, the two signals would contaminate each other and neither would mean what it says.

So the separation is structural rather than a convention someone has to remember:

* Baseline data lives in its own tables (`baseline_tests`, `baseline_test_problems`,
  `baseline_test_attempts`, `baseline_test_problem_results`) with its own scoring.
* `BaselineTestsModule` imports neither `AssignmentsModule`, `ScoringModule` nor
  `LeaderboardModule`. Having no handle on them is what guarantees a baseline result
  cannot reach a streak, a completion figure or a leaderboard position.
* Nothing in the daily path reads a baseline table.

The one thing the two share is the **submission mirror**. Grading an attempt is a range
query over `Submission` inside the attempt's window, so the existing LeetCode sync remains
the single ingestion path and no parallel provider integration exists to drift out of step.

## Lifecycle

```
DRAFT → SCHEDULED → ACTIVE → CLOSED
```

* **DRAFT** — editable, invisible to students.
* **SCHEDULED** — students see it is coming; the problems stay hidden.
* **ACTIVE** — attempts may be started and graded.
* **CLOSED** — terminal for participation. Closing grades every attempt one final time, so
  a submission that landed after the last sync but before the close time still counts.

Problems and audience are frozen once the test leaves `DRAFT`: students may already have
seen the list and started attempts, and swapping a question would invalidate results that
have been earned rather than "fixing" the test. Duplicating it is the supported route to a
corrected version.

`CLOSED → ACTIVE` is refused. Reopening a test whose report has been read and acted on
lets new attempts land against numbers people have already used.

## Audience

Identical to an assignment's: `campus` + `batch`, where null widens. Eligibility is
evaluated against the campus and batch on the student's own record, read server-side —
there is no campus parameter on any student route, so another campus's test is not merely
hidden but unreachable. Asking for one by id returns the same 404 as an id that does not
exist, so the endpoint cannot be used to enumerate what other campuses were set.

## Grading

Window: `[startedAt, min(expiresAt, submittedAt, now)]`. `expiresAt` is written once at
first start — `startedAt + durationMinutes`, clamped to the test's `closesAt` — so a later
change to the test's duration cannot retroactively shorten or extend an attempt already
under way, and refreshing the page cannot reset the clock.

Points default by difficulty (Easy 10, Medium 20, Hard 30) and are overridable per problem,
so "2 Easy, 2 Medium" scores sensibly without hand-entering weights every week.

Per-problem outcomes keep `ATTEMPTED_NOT_ACCEPTED` and `NOT_ATTEMPTED` distinct, for the
same reason the daily tracker does: a mentor reads "tried and failed" very differently from
"never opened it", and the first group is usually the one that most needs a conversation.

## Review signals

The programme wants to know when a result may not reflect the student's own work. What the
system will **not** do is conclude that.

Every signal is a timestamp fact the submission mirror can demonstrate:

| Signal | What it observes |
|---|---|
| `SOLVED_BEFORE_TEST` | an accepted submission exists from before the test opened |
| `IMMEDIATE_ACCEPTANCE` | accepted within 90s of the attempt starting |
| `RAPID_SUCCESSION` | two or more consecutive acceptances under 120s apart |
| `INCONSISTENT_WITH_HISTORY` | median solve time far below this student's own recent median |
| `NO_FAILED_ATTEMPTS` | three or more accepted, none with a failed submission |

There is deliberately **no plagiarism or similarity signal**. The public LeetCode API
exposes no submitted source, so any such claim would be fabricated. If an authenticated
provider ever supplies code, a signal can be added here — with its evidence — rather than
inferred from timing.

Signals produce a 0–100 triage score and, past 30, `reviewStatus = REVIEW_REQUIRED`. The
strongest thing the system is allowed to say is **"review recommended"**. That restraint is
not politeness: solving four easy problems in nine minutes is genuinely what a strong
student looks like, and a system that called that cheating would be wrong often enough to
be worse than useless.

Three consequences, each enforced in code:

* An attempt with nothing accepted is never flagged. A student who solved nothing cannot
  have solved it suspiciously, and flagging them would put exactly the people who need help
  into the review queue.
* Absent history means the pace signal is *not evaluated*, never "assume the worst".
* A re-grade never downgrades a `REVIEWED` a human has recorded. The system raises the
  flag; a person resolves it, with a note saying what they concluded.

Risk fields are mentor/admin-only, and that is a property of the *types*:
`StudentBaselineTest` has no `riskFlags`, `riskScore` or `reviewStatus` field at all, so
none of it can leak by someone forgetting to strip it.

## Reporting

`GET /baseline-tests/:id/report` returns participation (eligible / started / completed /
not started), score distribution, per-problem success rates, campus and batch breakdowns,
and the review queue ordered by signal strength.

"Not started" is derived from the eligible roster minus the attempts rather than stored: a
student who never opened the test has no attempt row, and manufacturing one would make
"started" meaningless. Groups with eligible students but no attempts still get a row —
"0 of 41 started" is the most useful line in the report, and omitting it hides the problem.

## Routes

```
GET    /baseline-tests                    list, filterable by campus/batch/status/date
POST   /baseline-tests                    create (DRAFT)
GET    /baseline-tests/:id
PATCH  /baseline-tests/:id                problems/audience are DRAFT-only
POST   /baseline-tests/:id/duplicate      this week's from last week's
POST   /baseline-tests/:id/publish
POST   /baseline-tests/:id/close          grades one final time
POST   /baseline-tests/:id/grade          re-grade from the submission mirror
GET    /baseline-tests/:id/report
GET    /baseline-tests/:id/attempts
PATCH  /baseline-tests/attempts/:id/review

GET    /student/baseline-tests            mine only — no campus/batch parameter exists
GET    /student/baseline-tests/:id
POST   /student/baseline-tests/:id/start  resumes if already started
POST   /student/baseline-tests/:id/submit
```

The admin controller carries `@Roles('ADMIN', 'MENTOR')` at the class level rather than per
method, so a route added later is closed until someone deliberately opens it.

## Student-wise leaderboard

`GET /baseline-tests/:id/leaderboard` — every eligible student, ranked competition-style
("1224": ties share a rank and the next distinct student skips ahead).

Two decisions are worth knowing about because they are load-bearing:

**The board is built from the eligible roster, not from the attempt rows.** A student who
never opened the test still gets a line, marked absent. Building it from attempts would
shrink the denominator and make a test half the cohort skipped look like a test everybody
took — and "who didn't turn up" is usually the more urgent list. The comparator never ranks
an absent student above one who sat it and scored nothing: both score 0, and on the
arithmetic alone the name tiebreak would put the absent student first, which reads as
though they outperformed someone who showed up.

**Rank is computed across the whole cohort before filtering.** Filter to one squad and its
members keep their standing among everyone rather than being renumbered 1..n. Rank means
"how many students did better"; it must not change because someone typed in a search box.
Summary statistics are cohort-wide for the same reason, and the average is taken over the
students who actually sat the test — an absent student is not a zero, they are not a
measurement.

`percent` is `solvedCount / totalQuestions`, deliberately *not* the difficulty-weighted
score. The columns beside it are counts, so a reader computes 3 of 4 and expects 75%; a
weighted 67% on the same row would disagree with its own numbers. The weighted figure is
still carried as `score`/`maxScore` for the mentor report, where difficulty is the point.

Supporting endpoints:

* `GET /baseline-tests/:id/students/:studentId` — one student's result with the
  per-question ✓/✗ breakdown. Uses the same `percent` definition, so the detail view and
  the board it was opened from cannot disagree.
* `GET /reports/export/baseline?testId=…&format=CSV` — the board as a file, in board order,
  absent students included so the export reconciles with the screen it came from.

### Immutability

Historical results never move. An attempt is graded within its own window
(`[startedAt, min(expiresAt, submittedAt, now)]`), so a student who solves the fourth
problem nine days after the test closed still shows 3/4 = 75% — even after a re-grade,
which is the operation that would rewrite history if the window were not frozen. Their
current ability is a separate number and belongs on a separate screen.

## Performance vs participation

The single most important distinction in this feature, and the one whose absence made an
entire cohort read 0/4 on problems many of them had solved.

| | Question | Source | Time filter |
|---|---|---|---|
| **Performance** | Can this student solve these problems? | submission mirror | **none** |
| **Participation** | Did they sit the test? | `BaselineTestAttempt` | the attempt window |

`solvedCount` on the leaderboard is performance. `status` is participation. A student can be
`NOT_STARTED` *and* 3/4 — both true, neither implying the other.

### What went wrong

`solvedCount` was read from `BaselineTestAttempt.solvedCount`, and an attempt row only
exists once a student presses Start in the portal. On a test nobody opened there were no
attempts, so every student defaulted to zero:

    eligible 99   attempts 0   problems 4
    students holding an accepted solution: 14   (40 accepted submissions)

The 60-minute duration was a *second* bug underneath — `gradeAttemptById` filters
submissions to `[startedAt, min(expiresAt, submittedAt, now)]`, so it would have discarded
those same solutions the moment attempts existed. Both are fixed; fixing only the visible
one leaves the other waiting.

### Why this does not break immutability

"Credit solutions written at any time" and "solving Q3 later must not change the recorded
3/4" look contradictory and are not — they describe different numbers:

* `inWindowSolvedCount` — what the sitting measured. Frozen. Solving a problem afterwards
  never moves it, and neither does a re-grade.
* `solvedCount` — what the student can do now. Rises when they solve something later.

Both are on the row, and the student detail shows the two side by side when they differ.

### Ranking

By performance, not attendance: a student who solved three of four and never opened the
test outranks one who sat it and solved none. What sinks is a student we have **never**
successfully synced — their 0 is an absence of evidence, so they rank last and render as
"Not synced" rather than 0%, never coloured as a bad result. Submission presence counts as
independent proof of measurement, since rows in the mirror could only be written by a read
that succeeded.

### Where it is enforced

`computeGeneralPerformance` in `@dsa/shared` is the whole rule, pure and unit-tested. The
service loads submissions for the eligible roster in one query and applies it. The
production smoke test fails the build if a test's mirror holds accepted solutions while its
leaderboard reports nobody solving anything — the bug stated as an assertion.
