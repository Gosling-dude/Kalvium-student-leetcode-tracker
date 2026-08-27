# Importing students

Admin → **Students → Import**, or `POST /api/v1/students/import` with an `.xlsx` file.

## Why roster files are never committed

This repository is public. Student names, email addresses and LeetCode handles are personal
data, so roster files stay out of git — the same reason `apps/api/prisma/roster.csv` is
gitignored. Prepared intake files live under `tmp/` on the operator's machine and are
deliberately untracked.

## Columns

| Column | Required | Notes |
|---|---|---|
| `Name` | yes | |
| `Email` | yes | The identity everything keys on — see below |
| `Squad` | no | `69`, `squad 69` and `Squad 69` all resolve to one squad |
| `LeetCode Username` | yes | A `/u/` profile URL, a bare handle, or a pasted page title |
| `Batch` | no | Created on demand if absent |
| `Phone` | no | |

Unknown columns are ignored, so a sheet carrying extra fields (register numbers, internship
track) imports cleanly without them being invented into the schema.

## Email is the identity, and is never derived

`Student.email` decides whether a re-import updates someone or creates a duplicate, and it
is the student's login. It is required, and the importer will not guess one.

That is not pedantry. The existing roster uses three different name conventions and two
squad formats:

    santhosh.bhaskar.s.144@kalvium.community     first.last.s.NNN
    vijayashree.a.s74@kalvium.community          first.initial.sNN
    nunsavathu.varun.s83@kalvium.community       last.first.sNN

A derived address that is wrong creates a student who can never log in, and who the later
correct import duplicates rather than updates.

## Campus

Required whenever more than one campus exists. The importer refuses rather than guessing: a
wrong guess files an entire cohort under a campus where no mentor is looking for them.

## LeetCode profiles

The column is resolved by the shared `resolveLeetcodeProfile` rule, so the importer and the
roster sync agree about what a given string means:

| Input | Result |
|---|---|
| `https://leetcode.com/u/handle/` | handle, accepted |
| `handle` | handle, accepted |
| `handle - LeetCode Profile` | handle recovered from the pasted title, flagged for verification |
| `https://leetcode.com/profile/` | `INVALID_PROFILE` — a generic page, not a student's |
| anything else | `NEEDS_PROFILE_URL` |

A row with **no** handle still imports. It syncs as `PROFILE_MISSING`, which reads as
"nobody has collected a handle yet" rather than as a failure — that distinction is why the
sync health panel does not report those students as broken.

Parsing is not verification. A well-formed URL can point at an account that does not exist;
that surfaces after import as `USER_NOT_FOUND` on the first sync, and is distinct from a
temporary `SYNC_FAILED`.

## Always dry-run first

Pass `dryRun=true` (the UI has a checkbox). It reports every row it would create, update or
skip, with per-row errors and their reasons, and writes nothing.

## Re-importing is safe

Rows are matched on email. An existing student is updated in place; the import never resets
a password, a submission, a baseline result, a streak or a historical placement.

**A blank cell is silence, not an erasure.** Email, LeetCode, Phone, Squad and Batch are all
left alone when the sheet does not supply them. This matters more than it sounds: a roster
assembled before anyone collected a student's LeetCode handle still carries the placeholder
in its profile column, and writing that blank through would erase a handle collected since,
taking the student's sync and their whole solved history off the dashboard with it.
Clearing a handle or an address is a deliberate single-student edit through the directory,
not something a bulk upload does as a side effect of a column nobody filled in.

## Reconciling — when the roster is the whole campus

`archiveAbsent` says "this file is the *complete* roster for this campus": everyone active
there and absent from it is **archived**. Off by default, because the ordinary upload is a
partial roster and reading one as "archive everyone else" would empty a campus from a
twelve-row file.

Archived, never deleted. `Submission.student` cascades on delete, so removing a departed
student would take their submissions with them and silently rewrite every report about a day
they were present. Archiving drops them out of the `status: ACTIVE` queries that make up the
current roster and leaves the history intact — and it reverses: name them on a later roster
and they come back ACTIVE on their own record, carrying their history, rather than as a
second student.

Two refusals guard it. It will not run without a campus, because the complement of the
roster would then be every student in the system. And it archives nobody when any row
errored — a student missing from a partially-applied roster is indistinguishable from one
whose row simply failed to save.

Dry-run it first. The dry run resolves identity for real and writes nothing, so it reports
which rows already exist, which are new, and exactly who would be archived.

## Onboarding a new institution

A roster for a campus the system has not seen before creates it, but only when the request
names it: a campus **code** alone is never enough. A typo in a code would otherwise split a
cohort across the real campus and a phantom one that looks just like it.

Filing them under an existing campus instead is the thing to avoid. Campus is what scopes
reports, assignment targeting and mentor access — so an Alliance student filed under SRM
appears in SRM's reports and becomes visible to SRM's mentors.

A new campus is created with the standard Foundation/Intermediate batches, because a campus
with no batches can hold no students and receive no assignments, which looks like a silent
import failure rather than a setup gap.

## Identity, and its one ambiguity

Rows are matched most-reliable-first: **email**, then **register number**, then **LeetCode
handle**, then **name within the campus**.

The last is a genuine fallback, and it has a limit worth knowing. A student with no email,
no register number and no handle can only be identified by their name — and name is
deliberately scoped to one campus, because two institutions can each have a "Rahul Sharma"
and they are different people. So importing such a student to a *different* campus creates a
second record rather than moving the first.

That is the correct reading of the evidence: the system genuinely cannot tell those two
apart. But it means moving a cohort between campuses is not something the importer can do
for students who have no stable identifier. Give them an email or a register number first,
and both re-imports and moves become exact.
