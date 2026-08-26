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
a password, a submission, a baseline result, a streak or a historical placement. A sheet
that omits the Squad or Batch column leaves those alone rather than clearing them — a
missing column says nothing about placement, it does not say "remove them".
