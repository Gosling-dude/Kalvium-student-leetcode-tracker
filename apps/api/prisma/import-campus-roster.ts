/**
 * Import a campus intake roster — the SRM onboarding, and every campus after it.
 *
 * Run with:
 *   npm run db:import:roster -w @dsa/api -- --campus=SRM --file=prisma/private/srm-roster.csv --dry-run
 *   npm run db:import:roster -w @dsa/api -- --campus=SRM --file=prisma/private/srm-roster.csv
 *
 * ## Why this is not `seed-students.ts`
 *
 * That script *synchronises*: the CSV is the complete truth for its campus, and anyone
 * missing from it is archived. This one *adds*: an intake form is a list of people who
 * joined, not a statement about who left. Running the intake file through the sync would
 * archive every student who happened not to fill the form in — so the two stay separate
 * and this script never archives, never deletes and never touches another campus.
 *
 * ## The rules it enforces (§3, §4, §5, §28, §42)
 *
 *  * **Identity is `LOWER(TRIM(email))`, and only that.** Ninety-nine rows describing
 *    ninety-two people produce ninety-two students. Names and squads repeat and drift;
 *    the address does not.
 *  * **A gap beats a guess.** A LeetCode value that is not a profile — `/settings/`,
 *    `/problemset/`, the bare homepage — imports as `null` and lands in the
 *    "Profile needs verification" list. It is never coerced into something that parses.
 *  * **No placement is invented.** The roster carries no belt level and no diagnostic
 *    result, so every student lands with **no batch at all** — `batchId` is null, shown
 *    as "Not Assigned". Foundation and Intermediate are assigned later, by an admin,
 *    from real assessment data. Cohort and belt are left null for the same reason.
 *  * **Idempotent.** Matching on the normalised email means a second run reports every
 *    student as unchanged and writes nothing.
 *  * **Dry run first.** `--dry-run` produces the full reconciliation report and writes
 *    nothing, so the numbers can be checked against the source before anything lands.
 *
 * The roster file itself is gitignored — it holds real names, addresses and handles, and
 * this repository is public (§28).
 *
 * Options:
 *   --campus=X   Campus code to import into (required).
 *   --file=X     CSV path (required). Columns: name, email, squad, leetcode.
 *   --dry-run    Report what *would* happen. Writes nothing.
 *   --batch=X    Place students into this batch code instead of leaving them unassigned.
 *                Only use it when a real placement decision has already been made.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import {
  describeProfileIssue,
  normaliseRoster,
  squadName,
  type NormalisedRosterStudent,
  type RawRosterRow,
} from '@dsa/shared';

const prisma = new PrismaClient();

/** Header aliases, lowercased and stripped of separators — the intake sheet's wording. */
const COLUMNS = {
  name: ['studentname', 'name', 'fullname'],
  email: ['emailidkalvium', 'email', 'emailid', 'kalviumemail', 'kalviumemailid'],
  squad: ['squadno', 'squad', 'squadnumber', 'group'],
  leetcode: [
    'leetcodeprofileurlleetcodewithpersonalid',
    'leetcodeprofileurl',
    'leetcode',
    'leetcodeprofile',
    'leetcodeusername',
    'leetcodeid',
  ],
} as const;

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A CSV parser that understands quoted fields.
 *
 * Written out rather than pulled in as a dependency because the intake file contains
 * commas inside pasted page titles, and a naive `split(',')` silently shifts every column
 * after them — which would attach one student's handle to another student's email.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

function readRoster(path: string): RawRosterRow[] {
  const absolute = resolve(process.cwd(), path);
  if (!existsSync(absolute)) {
    throw new Error(
      `Roster file not found at ${absolute}. The intake CSV is gitignored — copy it in ` +
        'before running the import.',
    );
  }

  const table = parseCsv(readFileSync(absolute, 'utf8'));
  const header = table[0];
  if (!header) throw new Error('The roster file is empty.');

  const index: Partial<Record<keyof typeof COLUMNS, number>> = {};
  header.forEach((cell, position) => {
    const key = normaliseHeader(cell);
    for (const [field, aliases] of Object.entries(COLUMNS) as [
      keyof typeof COLUMNS,
      readonly string[],
    ][]) {
      if (index[field] === undefined && aliases.includes(key)) index[field] = position;
    }
  });

  const missing = (['name', 'email'] as const).filter((field) => index[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `The roster is missing required column(s): ${missing.join(', ')}. ` +
        `Found headers: ${header.join(', ')}`,
    );
  }

  const read = (row: string[], field: keyof typeof COLUMNS): string | null => {
    const position = index[field];
    if (position === undefined) return null;
    const value = (row[position] ?? '').trim();
    return value === '' ? null : value;
  };

  return table.slice(1).map(
    (row, offset): RawRosterRow => ({
      // 1-based and counting the header, so a reported line number matches what an admin
      // sees when they open the file.
      rowNumber: offset + 2,
      name: read(row, 'name') ?? '',
      email: read(row, 'email') ?? '',
      squad: read(row, 'squad'),
      leetcode: read(row, 'leetcode'),
    }),
  );
}

interface Reconciliation {
  sourceRows: number;
  uniqueStudents: number;
  duplicateRows: number;
  rejectedRows: number;
  validProfiles: number;
  invalidOrMissingProfiles: number;
  newStudents: number;
  existingAtThisCampus: number;
  existingElsewhere: { email: string; campus: string; status: string }[];
  handleConflicts: { email: string; handle: string; ownedBy: string }[];
  offDomainEmails: string[];
}

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const campusCode = (arg('campus') ?? '').trim().toUpperCase();
  const file = arg('file');
  const batchCode = (arg('batch') ?? '').trim().toUpperCase();

  if (!campusCode) throw new Error('Pass --campus=<code>, e.g. --campus=SRM.');
  if (!file) throw new Error('Pass --file=<path to the roster CSV>.');

  const campus = await prisma.campus.findUnique({ where: { code: campusCode } });
  if (!campus) {
    const known = await prisma.campus.findMany({ select: { code: true } });
    throw new Error(
      `No campus with code "${campusCode}". Known: ${known.map((c) => c.code).join(', ')}.`,
    );
  }

  // No batch is the honest landing place: the intake supplies identity, squad and a
  // handle, and says nothing about belt level. Inventing Foundation or Intermediate here
  // would put a placement in front of a mentor that no assessment produced.
  //
  // `--batch=` exists for the case where a placement decision *has* already been made and
  // the roster is being loaded after the fact.
  const batch = batchCode
    ? await prisma.batch.findUnique({
        where: { campusId_code: { campusId: campus.id, code: batchCode } },
      })
    : null;
  if (batchCode && !batch) {
    throw new Error(
      `${campus.name} has no batch with code "${batchCode}". ` +
        'Create it first rather than letting an import invent a batch.',
    );
  }

  console.log(`\nCampus roster import${dryRun ? ' (DRY RUN — nothing will be written)' : ''}`);
  console.log(`  Campus: ${campus.code} — ${campus.name}`);
  console.log(`  Batch:  ${batch ? `${batch.code} — ${batch.name}` : 'Not Assigned (no batch)'}`);
  console.log(`  File:   ${file}\n`);

  const rows = readRoster(file);
  const roster = normaliseRoster(rows);

  // --- Reconciliation, before a single write ------------------------------
  //
  // Every number here is checkable against the source by hand, which is the point: the
  // import is only safe to run once these agree with what a human counted (§5, §42).

  const emails = roster.students.map((student) => student.email);
  const existing = await prisma.student.findMany({
    where: { email: { in: emails } },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      campusId: true,
      campus: { select: { code: true, name: true } },
    },
  });
  const existingByEmail = new Map(existing.map((student) => [student.email, student]));

  // A LeetCode handle is globally unique. A handle already owned by someone else — most
  // likely a Vels student who typed the same one — must be reported, not silently dropped
  // or, worse, taken from them.
  const handles = roster.students
    .map((student) => student.profile.username?.toLowerCase())
    .filter((handle): handle is string => !!handle);
  const handleOwners = await prisma.student.findMany({
    where: { leetcodeUsername: { in: handles } },
    select: { email: true, name: true, leetcodeUsername: true },
  });
  const ownerByHandle = new Map(
    handleOwners.map((owner) => [owner.leetcodeUsername!.toLowerCase(), owner]),
  );

  const reconciliation: Reconciliation = {
    sourceRows: roster.totalRows,
    uniqueStudents: roster.students.length,
    duplicateRows: roster.duplicateRows.length,
    rejectedRows: roster.rejectedRows.length,
    validProfiles: roster.students.filter((student) => student.profile.username !== null).length,
    invalidOrMissingProfiles: roster.students.filter(
      (student) => student.profile.username === null,
    ).length,
    newStudents: 0,
    existingAtThisCampus: 0,
    existingElsewhere: [],
    handleConflicts: [],
    offDomainEmails: roster.students
      .filter((student) => student.offDomainEmail)
      .map((student) => student.email),
  };

  for (const student of roster.students) {
    const match = existingByEmail.get(student.email);
    if (!match) {
      reconciliation.newStudents += 1;
    } else if (match.campusId === campus.id) {
      reconciliation.existingAtThisCampus += 1;
    } else {
      reconciliation.existingElsewhere.push({
        email: student.email,
        campus: match.campus?.code ?? 'unknown',
        status: match.status,
      });
    }

    const handle = student.profile.username?.toLowerCase();
    if (handle) {
      const owner = ownerByHandle.get(handle);
      if (owner && owner.email !== student.email) {
        reconciliation.handleConflicts.push({
          // A student without an email is still reportable — identified by name instead.
          email: student.email ?? `(no email) ${student.name}`,
          handle,
          ownedBy: owner.email ?? `(no email) ${owner.name}`,
        });
      }
    }
  }

  printReconciliation(reconciliation, roster);

  const blocking = reconciliation.existingElsewhere.length;
  if (blocking > 0) {
    console.log(
      `\n  ${blocking} email(s) already belong to a student at another campus. Those rows are ` +
        'skipped: moving someone between campuses is a transfer with an audit trail, not a\n' +
        '  side effect of an import (§16).',
    );
  }

  if (dryRun) {
    console.log('\nDry run complete — nothing was written.');
    return;
  }

  // --- Import -------------------------------------------------------------

  const squadNumbers = [...new Set(roster.students.map((s) => s.squad).filter((n): n is number => n !== null))];
  const squadIdByNumber = await ensureSquads(campus.id, squadNumbers);

  const today = new Date().toISOString().slice(0, 10);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const student of roster.students) {
    const match = existingByEmail.get(student.email);
    if (match && match.campusId !== campus.id) {
      skipped += 1;
      continue;
    }

    // A handle owned by someone else is dropped rather than applied: the unique index
    // would reject it anyway, and taking it from its owner would break *their* sync.
    // The student still imports — with no handle, and on the verification list.
    const handle = student.profile.username?.toLowerCase() ?? null;
    const owner = handle ? ownerByHandle.get(handle) : undefined;
    const usableHandle = owner && owner.email !== student.email ? null : handle;

    const squadId = student.squad !== null ? (squadIdByNumber.get(student.squad) ?? null) : null;

    try {
      if (!match) {
        await prisma.student.create({
          data: {
            name: student.name,
            email: student.email,
            leetcodeUsername: usableHandle,
            campusId: campus.id,
            batchId: batch?.id ?? null,
            squadId,
            status: 'ACTIVE',
            // Never-synced is not "solved nothing" — the distinction is what stops a
            // brand-new student being reported as a zero on their first morning.
            syncState: { create: { status: 'NEVER_SYNCED' } },
            campusHistory: {
              create: {
                toCampusId: campus.id,
                effectiveFromDayKey: today,
                source: 'IMPORT',
                reason: `${campus.name} intake roster`,
              },
            },
            // Recorded even when there is no batch: "enrolled on this day, unplaced" is
            // a fact worth keeping, and it gives the historical resolver an answer for
            // every day from enrolment onward instead of a gap.
            batchHistory: {
              create: {
                toBatchId: batch?.id ?? null,
                effectiveFromDayKey: today,
                source: 'IMPORT',
                reason: batch
                  ? 'Placed from roster import'
                  : 'Enrolled; batch assigned after the diagnostic assessment',
              },
            },
          },
        });
        created += 1;
        continue;
      }

      // Re-running must be a no-op, so only genuinely new information is written. In
      // particular an existing handle is never cleared by a roster row that has none —
      // the roster's silence is not a statement that the handle is wrong.
      const existingRow = await prisma.student.findUniqueOrThrow({
        where: { id: match.id },
        select: { name: true, squadId: true, leetcodeUsername: true },
      });

      const changes: Record<string, unknown> = {};
      if (student.name.length > existingRow.name.length) changes.name = student.name;
      if (squadId && existingRow.squadId !== squadId) changes.squadId = squadId;
      if (usableHandle && existingRow.leetcodeUsername !== usableHandle) {
        changes.leetcodeUsername = usableHandle;
      }

      if (Object.keys(changes).length > 0) {
        await prisma.student.update({ where: { id: match.id }, data: changes });
        updated += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failures.push(`${student.email}: ${(error as Error).message}`);
    }
  }

  console.log('\n  Import');
  console.log(`    Created:   ${created}`);
  console.log(`    Updated:   ${updated}`);
  console.log(`    Unchanged: ${skipped}`);
  if (failures.length > 0) {
    console.log(`    Failed:    ${failures.length}`);
    for (const failure of failures) console.log(`      ${failure}`);
  }

  const total = await prisma.student.count({ where: { campusId: campus.id, status: 'ACTIVE' } });
  const unassigned = await prisma.student.count({
    where: { campusId: campus.id, status: 'ACTIVE', batchId: null },
  });
  const needsVerification = await prisma.student.count({
    where: { campusId: campus.id, status: 'ACTIVE', leetcodeUsername: null },
  });
  const byBatch = await prisma.batch.findMany({
    where: { campusId: campus.id },
    select: {
      name: true,
      _count: { select: { students: { where: { status: 'ACTIVE' } } } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  console.log(`\n  ${campus.code} now has ${total} active student(s):`);
  for (const b of byBatch) console.log(`    ${b.name}: ${b._count.students}`);
  console.log(`    Not Assigned: ${unassigned}`);
  console.log(`    LeetCode profile needs verification: ${needsVerification}`);
  console.log('\nImport complete. Run a sync to pull LeetCode history.');
}

/**
 * Squads for this campus, created on demand.
 *
 * Looked up by `(campusId, name)` rather than name alone: squad numbers repeat across
 * campuses — SRM has 83, Vels has 8 — and a global lookup would file SRM's students into
 * a Vels squad.
 */
async function ensureSquads(
  campusId: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const number of numbers.sort((a, b) => a - b)) {
    const name = squadName(number);
    const existing = await prisma.squad.findFirst({ where: { campusId, name } });
    if (existing) {
      ids.set(number, existing.id);
      continue;
    }
    // No batch: SRM's squads exist while every student is still awaiting placement, so
    // there is no batch to attach them to yet.
    const squad = await prisma.squad.create({ data: { name, campusId } });
    ids.set(number, squad.id);
  }
  return ids;
}

function printReconciliation(
  reconciliation: Reconciliation,
  roster: ReturnType<typeof normaliseRoster>,
): void {
  const line = (label: string, value: number | string): void => {
    console.log(`    ${label.padEnd(34)} ${value}`);
  };

  console.log('  Reconciliation');
  line('Rows in source:', reconciliation.sourceRows);
  line('Unique students (by email):', reconciliation.uniqueStudents);
  line('Duplicate rows folded away:', reconciliation.duplicateRows);
  line('Rows rejected (no usable identity):', reconciliation.rejectedRows);
  line('Valid LeetCode profiles:', reconciliation.validProfiles);
  line('Invalid / missing profiles:', reconciliation.invalidOrMissingProfiles);
  line('New students:', reconciliation.newStudents);
  line('Already at this campus:', reconciliation.existingAtThisCampus);
  line('Already at another campus:', reconciliation.existingElsewhere.length);
  line('LeetCode handle conflicts:', reconciliation.handleConflicts.length);
  line('Off-domain email addresses:', reconciliation.offDomainEmails.length);

  if (roster.duplicateRows.length > 0) {
    console.log('\n  Duplicate rows (folded into the first occurrence):');
    for (const duplicate of roster.duplicateRows) {
      console.log(`    line ${duplicate.rowNumber} repeats line ${duplicate.firstSeenRow} — ${duplicate.email}`);
    }
  }

  if (roster.rejectedRows.length > 0) {
    console.log('\n  Rejected rows:');
    for (const rejected of roster.rejectedRows) {
      console.log(`    line ${rejected.rowNumber}: ${rejected.message}`);
    }
  }

  const needsVerification = roster.students.filter(
    (student: NormalisedRosterStudent) => student.profile.needsVerification,
  );
  if (needsVerification.length > 0) {
    console.log(`\n  Profiles needing verification (${needsVerification.length}):`);
    for (const student of needsVerification) {
      console.log(`    ${student.email.padEnd(46)} ${describeProfileIssue(student.profile)}`);
    }
  }

  if (reconciliation.handleConflicts.length > 0) {
    console.log('\n  LeetCode handle conflicts (handle kept by its current owner):');
    for (const conflict of reconciliation.handleConflicts) {
      console.log(`    ${conflict.email} wanted "${conflict.handle}", owned by ${conflict.ownedBy}`);
    }
  }

  if (reconciliation.existingElsewhere.length > 0) {
    console.log('\n  Emails already registered at another campus:');
    for (const clash of reconciliation.existingElsewhere) {
      console.log(`    ${clash.email.padEnd(46)} ${clash.campus} (${clash.status})`);
    }
  }
}

main()
  .catch((error) => {
    console.error('\nRoster import failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
