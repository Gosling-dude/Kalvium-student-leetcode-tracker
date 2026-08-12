/**
 * Synchronise the database with the authoritative student roster.
 *
 * Run with: `npm run db:seed:students -w @dsa/api` (add `--dry-run` first).
 *
 * `roster.csv` is **gitignored**: it holds students' real names and email addresses and
 * the repository is public. `roster.example.csv` documents the format with invented
 * data. When the file is absent this script skips quietly, so a fresh clone and the
 * deploy build both succeed without it.
 *
 * ## What "synchronise" means
 *
 * The CSV is the authority on *who is currently in the programme*, and email is the
 * identity. For every row: create the student if missing, otherwise update their name,
 * batch, cohort and belt in place. For every student in the database who is **not** in
 * the CSV: archive them.
 *
 * ## What is never touched
 *
 * Archiving is not deletion, and updating is not replacement. The following survive
 * every run, for every student, including archived ones:
 *
 *   * submissions (the mirror — unrecoverable from LeetCode's 20-row window)
 *   * daily statuses, and the historical batch frozen on them
 *   * streak history, leaderboard entries, achievements
 *   * blockers, mentor notes, email report history
 *   * `createdAt` and every other audit timestamp
 *   * an existing LeetCode username, unless the CSV supplies a different one
 *
 * A student with no history at all and no roster row is genuinely disposable, and is
 * deleted rather than left as clutter — but that is the only deletion this script can
 * ever perform, and it is guarded by a count of every table that references them.
 *
 * ## Idempotency
 *
 * Matching is on the normalised (lowercased, trimmed) email, so running twice in a row
 * reports every student as unchanged and writes nothing. That matters because the Render
 * deploy build runs this on every deploy.
 *
 * Options:
 *   --dry-run   Parse, validate and report what *would* change. Writes nothing.
 *   --file=X    Load a different CSV (same headers).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/** Header aliases, lowercased and stripped of separators — the sheet's exact wording. */
const COLUMNS = {
  name: ['fullname', 'name', 'studentname'],
  email: ['kalviumemailid', 'email', 'emailid', 'kalviumemail'],
  batch: ['batch', 'currentbatch', 'batchcode', 'level'],
  cohort: ['cohort', 'cohortno', 'cohortnumber'],
  belt: ['maxbeltlevel', 'belt', 'beltlevel', 'maxbelt'],
  squad: ['squad', 'squadno', 'squadnumber', 'group'],
  username: ['leetcodeusername', 'leetcodeid', 'username'],
  profileUrl: ['leetcodeprofilelink', 'leetcodeprofile', 'profilelink', 'profileurl'],
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** LeetCode handles: letters, digits, underscore and hyphen, 1–39 characters. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

/**
 * Batch names accepted in the CSV's Batch column, mapped to a batch `code`.
 *
 * Only an alias table — the code is still looked up in the database, so a CSV naming a
 * batch that does not exist fails loudly instead of inventing one.
 */
const BATCH_ALIASES: Record<string, string> = {
  A: 'A',
  B: 'B',
  FOUNDATION: 'A',
  'FOUNDATIONLEVEL': 'A',
  'AFOUNDATIONLEVEL': 'A',
  INTERMEDIATE: 'B',
  'INTERMEDIATELEVEL': 'B',
  'BINTERMEDIATELEVEL': 'B',
};

interface RosterRow {
  line: number;
  name: string;
  email: string;
  batchCode: string;
  cohort: number | null;
  maxBeltLevel: number | null;
  squad: string | null;
  username: string | null;
}

interface RowProblem {
  line: number;
  message: string;
}

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.()]/g, '');
}

/** The canonical identity key. Email is the roster's primary key (§28). */
function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Minimal RFC-4180 parser: handles quoted fields and embedded commas, which appear as
 * soon as someone's name contains one. Not worth a dependency for one file.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise corrupt the first header.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
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

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Mentors paste whole profile URLs into the username column, and some rows carry a URL
 * but a blank handle. Deriving the handle from either is cheaper than rejecting the row.
 * Returns null when the roster simply has no handle for this student, which is allowed.
 */
function normaliseUsername(raw: string, profileUrl: string | null): string | null {
  const fromUrl = (value: string): string | null => {
    const match = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(value);
    return match?.[1] ?? null;
  };

  const trimmed = raw.trim();
  if (trimmed) {
    const embedded = fromUrl(trimmed);
    if (embedded) return embedded;
    // Sheets sometimes hold "Harish _Karthick" where the profile says "Harish_Karthick".
    return trimmed.replace(/^@/, '').replace(/\s+/g, '') || null;
  }

  return profileUrl ? fromUrl(profileUrl) : null;
}

/** `A (Foundation Level)`, `Foundation`, `A` → `A`. */
function normaliseBatch(raw: string): string | null {
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (!key) return null;
  return BATCH_ALIASES[key] ?? raw.trim().toUpperCase();
}

function parseRoster(path: string): {
  rows: RosterRow[];
  problems: RowProblem[];
  mentionedEmails: Set<string>;
} {
  const table = parseCsv(readFileSync(path, 'utf8'));
  const header = table[0];
  if (!header) throw new Error(`${path} is empty.`);

  const index: Partial<Record<keyof typeof COLUMNS, number>> = {};
  header.forEach((cell, position) => {
    const normalised = normaliseHeader(cell);
    for (const [field, aliases] of Object.entries(COLUMNS) as [
      keyof typeof COLUMNS,
      readonly string[],
    ][]) {
      if (index[field] === undefined && aliases.includes(normalised)) index[field] = position;
    }
  });

  const missing = (['name', 'email', 'batch'] as const).filter((f) => index[f] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${path} is missing required column(s): ${missing.join(', ')}. ` +
        'Expected headers: Full Name, Kalvium Email ID, Batch, Cohort, Max Belt Level, ' +
        'Squad, Leet code user name, Leet code profile link.',
    );
  }

  const rows: RosterRow[] = [];
  const problems: RowProblem[] = [];
  const seenEmails = new Map<string, number>();
  const seenUsernames = new Map<string, number>();

  /**
   * Every email the sheet mentions, valid or not.
   *
   * The archive step uses this rather than the accepted rows: a student whose row failed
   * validation is still *on* the roster, and archiving them because of a typo in their
   * belt level would remove a current student from every live view.
   */
  const mentionedEmails = new Set<string>();

  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i]!;
    const line = i + 1;
    const read = (field: keyof typeof COLUMNS): string => {
      const position = index[field];
      return position === undefined ? '' : (cells[position] ?? '').trim();
    };

    const name = read('name');
    const email = normaliseEmail(read('email'));
    const rawUsername = read('username');
    const profileUrl = read('profileUrl') || null;

    if (!name && !email && !rawUsername) continue; // trailing blank line
    if (email) mentionedEmails.add(email);

    const username = normaliseUsername(rawUsername, profileUrl);
    const squad = read('squad') || null;
    const batchCode = normaliseBatch(read('batch'));

    const cohortRaw = read('cohort');
    const cohort = cohortRaw ? Number.parseInt(cohortRaw, 10) : null;
    const beltRaw = read('belt');
    const maxBeltLevel = beltRaw ? Number.parseInt(beltRaw, 10) : null;

    if (!name) problems.push({ line, message: 'Full Name is required' });
    if (!email) {
      problems.push({ line, message: 'Kalvium Email ID is required' });
    } else if (!EMAIL_PATTERN.test(email)) {
      problems.push({ line, message: `"${email}" is not a valid email address` });
    }
    if (!batchCode) {
      problems.push({ line, message: `${name || email}: Batch is required (e.g. "A" or "B")` });
    }
    if (cohortRaw && (cohort === null || Number.isNaN(cohort))) {
      problems.push({ line, message: `"${cohortRaw}" is not a valid cohort number` });
    }
    if (beltRaw && (maxBeltLevel === null || Number.isNaN(maxBeltLevel))) {
      problems.push({ line, message: `"${beltRaw}" is not a valid belt level` });
    }
    // A missing handle is allowed; a malformed one is not, because it would be silently
    // synced against and reported as "user not found".
    if (username && !USERNAME_PATTERN.test(username)) {
      problems.push({ line, message: `"${username}" is not a valid LeetCode username` });
    }

    const priorEmail = seenEmails.get(email);
    if (priorEmail !== undefined) {
      problems.push({ line, message: `Email duplicates line ${priorEmail}` });
      continue;
    }
    if (username) {
      const priorUsername = seenUsernames.get(username.toLowerCase());
      if (priorUsername !== undefined) {
        problems.push({ line, message: `LeetCode username duplicates line ${priorUsername}` });
        continue;
      }
    }

    const usable =
      name &&
      email &&
      EMAIL_PATTERN.test(email) &&
      batchCode &&
      (!username || USERNAME_PATTERN.test(username)) &&
      !Number.isNaN(cohort as number) &&
      !Number.isNaN(maxBeltLevel as number);
    if (!usable) continue;

    seenEmails.set(email, line);
    if (username) seenUsernames.set(username.toLowerCase(), line);

    rows.push({
      line,
      name,
      email,
      batchCode: batchCode!,
      cohort: cohort === null || Number.isNaN(cohort) ? null : cohort,
      maxBeltLevel:
        maxBeltLevel === null || Number.isNaN(maxBeltLevel) ? null : maxBeltLevel,
      squad,
      username,
    });
  }

  return { rows, problems, mentionedEmails };
}

/** Program-local day key for an arbitrary instant, matching `ProgramTimeService.dayKeyOf`. */
export function dayKeyOf(date: Date): string {
  const timezone = process.env.PROGRAM_TIMEZONE ?? 'Asia/Kolkata';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Program-local day key "now", matching `ProgramTimeService.today()`. */
function todayDayKey(): string {
  return dayKeyOf(new Date());
}

/**
 * When a roster sync moves an existing student to a different batch, which day the move
 * should take effect from.
 *
 * "First placement" is decided by `hasPriorPlacements`, not by whether `Student.batchId`
 * was already non-null — a student can carry a `batchId` that was never actually recorded
 * as a placement (the classic case: an old import stamped everyone onto a placeholder
 * batch like "Batch 2026" before `StudentBatchHistory` existed). Checking history directly
 * is what makes that distinguishable from a genuine administrative move:
 *
 *  - No prior placement on record → back-dated to enrolment. The roster is stating what
 *    has been true all along, not making a change now.
 *  - At least one prior placement → effective today. An admin moving someone now is a
 *    decision about now, and back-dating it would re-file already-closed days.
 *
 * Pure so the decision itself is unit-testable without a database.
 */
export function resolvePlacementEffectiveDate(input: {
  hasPriorPlacements: boolean;
  todayDayKey: string;
  enrolmentDayKey: string;
}): string {
  return input.hasPriorPlacements ? input.todayDayKey : input.enrolmentDayKey;
}

interface Summary {
  created: string[];
  updated: string[];
  movedBatch: string[];
  archived: string[];
  deleted: string[];
  unchanged: string[];
  failures: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => a.startsWith('--file='))?.slice('--file='.length);
  const path = resolve(fileArg ?? resolve(__dirname, 'roster.csv'));

  // `roster.csv` is gitignored — it holds real names and email addresses, and the repo
  // is public. Its absence is therefore the normal state of a fresh clone and of the
  // deploy build, not an error: skip quietly so `db:seed` still succeeds. An explicit
  // `--file=` is different — the caller named a file, so a missing one is a real mistake.
  if (!existsSync(path)) {
    if (fileArg) throw new Error(`No such roster file: ${path}`);
    console.log(`No roster at ${path} — skipping.`);
    console.log('  Copy roster.example.csv to roster.csv and re-run to load real students.');
    return;
  }

  console.log(`Synchronising roster from ${path}${dryRun ? ' (dry run — nothing will be written)' : ''}…`);

  const { rows, problems, mentionedEmails } = parseRoster(path);

  for (const problem of problems) {
    console.warn(`  line ${problem.line}: ${problem.message}`);
  }
  console.log(`  ${rows.length} valid row(s), ${problems.length} problem(s)`);

  // Batches must already exist — they are created by the batch-architecture migration.
  // Failing here is deliberate: silently creating a batch from a typo'd CSV cell would
  // split the roster across a batch nobody meant to make.
  const batches = await prisma.batch.findMany({ select: { id: true, code: true, name: true } });
  const batchByCode = new Map(batches.map((batch) => [batch.code.toUpperCase(), batch]));

  const unknownBatches = [...new Set(rows.map((r) => r.batchCode))].filter(
    (code) => !batchByCode.has(code),
  );
  if (unknownBatches.length > 0) {
    throw new Error(
      `The roster references batch code(s) that do not exist: ${unknownBatches.join(', ')}. ` +
        `Known codes: ${[...batchByCode.keys()].join(', ')}. ` +
        'Create the batch first (admin → Batch Management) rather than letting the roster invent one.',
    );
  }

  const today = todayDayKey();
  const summary: Summary = {
    created: [],
    updated: [],
    movedBatch: [],
    archived: [],
    deleted: [],
    unchanged: [],
    failures: [],
  };

  // Squads are looked up by (name, batchId) rather than upserted on name alone: the
  // unique constraint is per batch, so a bare `upsert({ where: { name } })` is not valid.
  const squadColors = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7'];
  const squadIds = new Map<string, string>();

  if (!dryRun) {
    const squadKeys = [
      ...new Set(
        rows
          .filter((row) => row.squad)
          .map((row) => `${batchByCode.get(row.batchCode)!.id}::${row.squad}`),
      ),
    ].sort();

    for (const [position, key] of squadKeys.entries()) {
      const [batchId, name] = key.split('::') as [string, string];
      const existing = await prisma.squad.findFirst({ where: { name, batchId } });
      const squad =
        existing ??
        (await prisma.squad.create({
          data: { name, batchId, color: squadColors[position % squadColors.length] },
        }));
      squadIds.set(key, squad.id);
    }
  }

  for (const row of rows) {
    const batch = batchByCode.get(row.batchCode)!;
    const squadId = row.squad ? (squadIds.get(`${batch.id}::${row.squad}`) ?? null) : null;
    const leetcodeUsername = row.username ? row.username.toLowerCase() : null;
    const label = `${row.name} <${row.email}>`;

    try {
      const existing = await prisma.student.findUnique({
        where: { email: row.email },
        select: {
          id: true,
          name: true,
          batchId: true,
          cohort: true,
          maxBeltLevel: true,
          squadId: true,
          status: true,
          leetcodeUsername: true,
          createdAt: true,
        },
      });

      if (!existing) {
        // A handle already taken by *another* student would violate the unique index.
        // Report it rather than failing the whole run — the roster still owns this
        // student's identity by email, and the handle can be corrected afterwards.
        if (leetcodeUsername) {
          const handleOwner = await prisma.student.findUnique({
            where: { leetcodeUsername },
            select: { email: true },
          });
          if (handleOwner && handleOwner.email !== row.email) {
            summary.failures.push(
              `line ${row.line}: LeetCode handle "${row.username}" already belongs to another student`,
            );
            continue;
          }
        }

        if (!dryRun) {
          await prisma.student.create({
            data: {
              name: row.name,
              email: row.email,
              leetcodeUsername,
              batchId: batch.id,
              squadId,
              cohort: row.cohort,
              maxBeltLevel: row.maxBeltLevel,
              status: 'ACTIVE',
              // Never synced is not the same as "solved nothing" — the distinction is
              // what stops a brand-new student being reported as a zero.
              syncState: { create: { status: 'NEVER_SYNCED' } },
              // The first placement is back-dated to enrolment rather than to today: the
              // roster is stating what has been true all along, not making a change now.
              // It cannot rewrite anything, because a DailyStatus that already carries a
              // batch is never re-stamped (§7).
              batchHistory: {
                create: {
                  toBatchId: batch.id,
                  effectiveFromDayKey: today,
                  source: 'ROSTER_SYNC',
                  reason: 'Initial placement from roster',
                },
              },
            },
          });
        }
        summary.created.push(label);
        continue;
      }

      // Which fields actually differ. Computed rather than blind-writing so the summary
      // can distinguish "unchanged" from "updated", which is what makes a second run
      // provably a no-op.
      const batchChanged = existing.batchId !== batch.id;
      const changes: Prisma.StudentUpdateInput = {};
      if (existing.name !== row.name) changes.name = row.name;
      if (existing.cohort !== row.cohort) changes.cohort = row.cohort;
      if (existing.maxBeltLevel !== row.maxBeltLevel) changes.maxBeltLevel = row.maxBeltLevel;
      if (batchChanged) changes.batch = { connect: { id: batch.id } };
      if (squadId && existing.squadId !== squadId) changes.squad = { connect: { id: squadId } };

      // The roster does not own the LeetCode handle: it is collected separately and is
      // often absent from the sheet. Only ever *fill in* a missing one or apply an
      // explicit change — never blank out a handle the student already has (§2).
      if (leetcodeUsername && existing.leetcodeUsername !== leetcodeUsername) {
        changes.leetcodeUsername = leetcodeUsername;
      }

      // A student who had left and is back on the roster returns to ACTIVE.
      const reactivating = existing.status === 'ARCHIVED';
      if (reactivating) {
        changes.status = 'ACTIVE';
        changes.archivedAt = null;
        changes.archivedReason = null;
      }

      if (Object.keys(changes).length === 0) {
        summary.unchanged.push(label);
        continue;
      }

      if (!dryRun) {
        await prisma.student.update({ where: { id: existing.id }, data: changes });

        if (batchChanged) {
          // "First placement" is *not* `existing.batchId === null` — a student can carry a
          // non-null `batchId` that nonetheless was never actually recorded as a placement
          // (the classic case: an old import stamped everyone onto a placeholder batch
          // like "Batch 2026" without ever writing a `StudentBatchHistory` row, because that
          // table didn't exist yet). Checking history directly, not the batchId, is what
          // makes that distinguishable from a genuine administrative move.
          //
          // A genuine move (the student already has at least one recorded placement)
          // is effective from today, so days already closed keep the batch they were
          // actually completed under (§7) — an admin moving someone now is a decision
          // about now. A first-ever recorded placement is back-dated to enrolment instead:
          // the roster is stating what has been true all along, not making a change now.
          // Neither can rewrite a closed day, because a `DailyStatus` that already carries
          // a batch is never re-stamped by an ordinary recompute.
          const priorPlacements = await prisma.studentBatchHistory.count({
            where: { studentId: existing.id },
          });
          const isFirstPlacement = priorPlacements === 0;
          const effectiveFromDayKey = resolvePlacementEffectiveDate({
            hasPriorPlacements: !isFirstPlacement,
            todayDayKey: today,
            enrolmentDayKey: dayKeyOf(existing.createdAt),
          });

          await prisma.studentBatchHistory.create({
            data: {
              studentId: existing.id,
              fromBatchId: existing.batchId,
              toBatchId: batch.id,
              effectiveFromDayKey,
              source: 'ROSTER_SYNC',
              reason: isFirstPlacement
                ? 'Initial placement from roster (back-dated to enrolment — no prior placement on record)'
                : 'Batch changed by roster sync',
            },
          });
        }
      }

      if (batchChanged) summary.movedBatch.push(label);
      else summary.updated.push(label);
    } catch (error) {
      summary.failures.push(`line ${row.line}: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Students no longer on the roster
  // ---------------------------------------------------------------------------
  //
  // Archived, never deleted, whenever they have any history at all. Their submissions
  // are the only copy that exists — LeetCode exposes 20 recent entries and nothing more
  // — and their past results are facts that stay true after they leave (§2, §24, §29).
  // Archiving removes them from every current view; it removes nothing from the record.

  const orphans = await prisma.student.findMany({
    where: { email: { notIn: [...mentionedEmails] }, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, email: true },
  });

  for (const orphan of orphans) {
    const label = `${orphan.name} <${orphan.email}>`;
    try {
      const [submissions, statuses, entries, blockers, placements, notes] = await Promise.all([
        prisma.submission.count({ where: { studentId: orphan.id } }),
        prisma.dailyStatus.count({ where: { studentId: orphan.id } }),
        prisma.leaderboardEntry.count({ where: { studentId: orphan.id } }),
        prisma.blocker.count({ where: { studentId: orphan.id } }),
        prisma.studentBatchHistory.count({ where: { studentId: orphan.id } }),
        prisma.mentorNote.count({ where: { studentId: orphan.id } }),
      ]);
      const historyCount = submissions + statuses + entries + blockers + placements + notes;

      if (historyCount === 0) {
        // Nothing to preserve: no submissions, no results, no notes, no placements.
        // Deleting is safe here and keeps the roster clean, but it is the *only* case.
        if (!dryRun) await prisma.student.delete({ where: { id: orphan.id } });
        summary.deleted.push(label);
        continue;
      }

      if (!dryRun) {
        await prisma.student.update({
          where: { id: orphan.id },
          data: {
            status: 'ARCHIVED',
            archivedAt: new Date(),
            archivedReason: 'Not present in the current authoritative roster',
          },
        });
      }
      summary.archived.push(`${label} (${historyCount} historical record(s) preserved)`);
    } catch (error) {
      summary.failures.push(`${label}: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  //
  // Counts always; names only under --dry-run, where a human is reviewing the change
  // before applying it. A real run's output can land in CI logs, and the roster is a
  // private operational input that must not be published (§27).

  const line = (label: string, items: string[]): void => {
    console.log(`  ${label.padEnd(12)} ${items.length}`);
    if (dryRun && items.length > 0) {
      for (const item of items) console.log(`      ${item}`);
    }
  };

  console.log('\nRoster synchronisation summary:');
  line('Created:', summary.created);
  line('Updated:', summary.updated);
  line('Moved batch:', summary.movedBatch);
  line('Archived:', summary.archived);
  line('Deleted:', summary.deleted);
  line('Unchanged:', summary.unchanged);

  if (summary.failures.length > 0) {
    console.log(`  ${'Failed:'.padEnd(12)} ${summary.failures.length}`);
    for (const failure of summary.failures) console.warn(`      ${failure}`);
  }

  // Per-batch totals, so the counts the programme cares about are verifiable at a glance.
  if (!dryRun) {
    const perBatch = await prisma.student.groupBy({
      by: ['batchId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });
    const nameById = new Map(batches.map((b) => [b.id, `${b.code} — ${b.name}`]));
    const total = perBatch.reduce((n, group) => n + group._count._all, 0);

    console.log('\n  Active students by batch:');
    for (const group of perBatch.sort((a, b) =>
      (nameById.get(a.batchId ?? '') ?? '').localeCompare(nameById.get(b.batchId ?? '') ?? ''),
    )) {
      console.log(
        `    ${(nameById.get(group.batchId ?? '') ?? 'No batch').padEnd(28)} ${group._count._all}`,
      );
    }
    console.log(`    ${'TOTAL'.padEnd(28)} ${total}`);

    const archivedTotal = await prisma.student.count({ where: { status: 'ARCHIVED' } });
    console.log(`\n  Archived (retained with full history): ${archivedTotal}`);
  }

  console.log(
    dryRun
      ? '\nDry run complete — nothing was written.'
      : '\nRoster synchronisation complete. Run a sync to pull LeetCode history.',
  );
}

main()
  .catch((error) => {
    console.error('Roster synchronisation failed:', (error as Error).message);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
