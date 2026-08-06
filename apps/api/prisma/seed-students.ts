/**
 * Load the real Kalvium roster from `prisma/roster.csv`.
 *
 * Run with: `npm run db:seed:students -w @dsa/api`
 *
 * `roster.csv` is **gitignored**: it holds students' real names and email addresses and
 * the repository is public. `roster.example.csv` documents the format. When the file is
 * absent this script skips quietly, so a fresh clone and the deploy build both succeed
 * without it.
 *
 * Separate from `seed.ts` on purpose. `seed.ts` creates the admin, the scoring formula
 * and — outside production — a *synthetic* demo cohort; this script loads real students
 * who must exist in production too. Keeping them apart means the roster can be reloaded
 * after every spreadsheet update without also regenerating fake history, and it can run
 * in production where demo seeding is deliberately disabled.
 *
 * Idempotent: students are matched on email, so re-running after a roster edit updates
 * names, squads and handles in place rather than creating duplicates. Nothing is ever
 * deleted — a student dropped from the sheet is reported, not removed, because deleting
 * them would cascade away their entire submission history.
 *
 * Options:
 *   --dry-run   Parse, validate and report without writing anything.
 *   --file=X    Load a different CSV (same headers).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** The batch every roster student belongs to. Squads live inside it. */
const BATCH_NAME = process.env.ROSTER_BATCH_NAME ?? 'Batch 2026';

/** Header aliases, lowercased and stripped of separators — the sheet's exact wording. */
const COLUMNS = {
  name: ['fullname', 'name', 'studentname'],
  email: ['kalviumemailid', 'email', 'emailid', 'kalviumemail'],
  squad: ['squad', 'squadno', 'squadnumber', 'group'],
  username: ['leetcodeusername', 'leetcodeusername', 'leetcodeid', 'username'],
  profileUrl: ['leetcodeprofilelink', 'leetcodeprofile', 'profilelink', 'profileurl'],
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** LeetCode handles: letters, digits, underscore and hyphen, 1–39 characters. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

interface RosterRow {
  line: number;
  name: string;
  email: string;
  squad: string | null;
  username: string;
  profileUrl: string | null;
}

interface RowProblem {
  line: number;
  message: string;
}

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_\-.]/g, '');
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
 * but a blank handle. Deriving the handle from either is cheaper than rejecting the row:
 * a rejected student is silently missing from every report.
 */
function normaliseUsername(raw: string, profileUrl: string | null): string {
  const fromUrl = (value: string): string | null => {
    const match = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(value);
    return match?.[1] ?? null;
  };

  const trimmed = raw.trim();
  if (trimmed) {
    const embedded = fromUrl(trimmed);
    if (embedded) return embedded;
    // Sheets sometimes hold "Harish _Karthick" where the profile says "Harish_Karthick".
    return trimmed.replace(/^@/, '').replace(/\s+/g, '');
  }

  return profileUrl ? (fromUrl(profileUrl) ?? '') : '';
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
    for (const [field, aliases] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly string[]][]) {
      if (index[field] === undefined && aliases.includes(normalised)) index[field] = position;
    }
  });

  const missing = (['name', 'email', 'squad'] as const).filter((f) => index[f] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${path} is missing required column(s): ${missing.join(', ')}. ` +
        'Expected headers: Full Name, Kalvium Email ID, Squad, Leet code user name, Leet code profile link.',
    );
  }

  const rows: RosterRow[] = [];
  const problems: RowProblem[] = [];
  const seenEmails = new Map<string, number>();
  const seenUsernames = new Map<string, number>();
  /**
   * Every email the sheet mentions, valid or not. The orphan report at the end uses
   * this rather than the accepted rows: a student whose row failed validation is still
   * *on* the roster, and listing them as "no longer in the roster" would invite someone
   * to delete a student who is simply mistyped.
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
    const email = read('email').toLowerCase();
    const rawUsername = read('username');
    const profileUrl = read('profileUrl') || null;

    if (!name && !email && !rawUsername) continue; // trailing blank line
    if (email) mentionedEmails.add(email);

    const username = normaliseUsername(rawUsername, profileUrl);
    const squad = read('squad') || null;

    if (!name) problems.push({ line, message: 'Full Name is required' });
    if (!email) {
      problems.push({ line, message: 'Kalvium Email ID is required' });
    } else if (!EMAIL_PATTERN.test(email)) {
      problems.push({ line, message: `"${email}" is not a valid email address` });
    }
    if (!username) {
      problems.push({ line, message: `${name || email}: no LeetCode username or profile link` });
    } else if (!USERNAME_PATTERN.test(username)) {
      problems.push({ line, message: `"${username}" is not a valid LeetCode username` });
    }

    const priorEmail = seenEmails.get(email);
    if (priorEmail !== undefined) {
      problems.push({ line, message: `Email duplicates line ${priorEmail}` });
      continue;
    }
    const priorUsername = seenUsernames.get(username.toLowerCase());
    if (priorUsername !== undefined) {
      problems.push({ line, message: `LeetCode username duplicates line ${priorUsername}` });
      continue;
    }

    if (!name || !email || !EMAIL_PATTERN.test(email) || !USERNAME_PATTERN.test(username)) continue;

    seenEmails.set(email, line);
    seenUsernames.set(username.toLowerCase(), line);
    rows.push({ line, name, email, squad, username, profileUrl });
  }

  return { rows, problems, mentionedEmails };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => a.startsWith('--file='))?.slice('--file='.length);
  const path = resolve(fileArg ?? resolve(__dirname, 'roster.csv'));

  // `roster.csv` is gitignored — it holds real names and email addresses, and the repo
  // is public. Its absence is therefore the normal state of a fresh clone and of the
  // deploy build, not an error: skip quietly so `db:seed` still succeeds. An explicit
  // `--file=` is different — the caller named a file, so a missing one is a real
  // mistake and must fail loudly.
  if (!existsSync(path)) {
    if (fileArg) throw new Error(`No such roster file: ${path}`);
    console.log(`No roster at ${path} — skipping.`);
    console.log('  Copy roster.example.csv to roster.csv and re-run to load real students.');
    return;
  }

  console.log(`Loading roster from ${path}${dryRun ? ' (dry run)' : ''}…`);

  const { rows, problems, mentionedEmails } = parseRoster(path);

  for (const problem of problems) {
    console.warn(`  line ${problem.line}: ${problem.message}`);
  }

  console.log(`  ${rows.length} valid row(s), ${problems.length} problem(s)`);

  if (dryRun) {
    const bySquad = new Map<string, number>();
    for (const row of rows) bySquad.set(row.squad ?? '—', (bySquad.get(row.squad ?? '—') ?? 0) + 1);
    for (const [squad, count] of [...bySquad].sort()) console.log(`  Squad ${squad}: ${count}`);
    console.log('Dry run — nothing written.');
    return;
  }

  const batch = await prisma.batch.upsert({
    where: { name: BATCH_NAME },
    create: { name: BATCH_NAME, isActive: true },
    update: {},
  });

  // Squads are looked up by (name, batchId) rather than upserted on name alone: the
  // unique constraint is per batch, so a bare `upsert({ where: { name } })` is not valid.
  const squadColors = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7'];
  const squadIds = new Map<string, string>();
  const squadNames = [...new Set(rows.map((r) => r.squad).filter((s): s is string => !!s))].sort();

  for (const [position, name] of squadNames.entries()) {
    const existing = await prisma.squad.findFirst({ where: { name, batchId: batch.id } });
    const squad =
      existing ??
      (await prisma.squad.create({
        data: { name, batchId: batch.id, color: squadColors[position % squadColors.length] },
      }));
    squadIds.set(name, squad.id);
  }
  console.log(`  squads: ${squadNames.join(', ')} (in "${batch.name}")`);

  let created = 0;
  let updated = 0;
  const failures: string[] = [];

  for (const row of rows) {
    const squadId = row.squad ? (squadIds.get(row.squad) ?? null) : null;
    // Stored lowercase to match the rest of the system; LeetCode lookups are
    // case-insensitive (verified against the live endpoint), and the canonical casing
    // comes back from the provider into `leetcodeDisplayName` on the first sync.
    const leetcodeUsername = row.username.toLowerCase();

    try {
      const existing = await prisma.student.findFirst({
        where: { OR: [{ email: row.email }, { leetcodeUsername }] },
        select: { id: true, email: true },
      });

      if (existing) {
        if (existing.email !== row.email) {
          failures.push(
            `line ${row.line}: LeetCode handle "${row.username}" already belongs to ${existing.email}`,
          );
          continue;
        }
        await prisma.student.update({
          where: { id: existing.id },
          data: { name: row.name, leetcodeUsername, batchId: batch.id, squadId },
        });
        updated += 1;
      } else {
        await prisma.student.create({
          data: {
            name: row.name,
            email: row.email,
            leetcodeUsername,
            batchId: batch.id,
            squadId,
            // Never synced is not the same as "solved nothing" — the distinction is
            // what stops a brand-new student being reported as a zero.
            syncState: { create: { status: 'NEVER_SYNCED' } },
          },
        });
        created += 1;
      }
    } catch (error) {
      failures.push(`line ${row.line} (${row.email}): ${(error as Error).message}`);
    }
  }

  // Report, never delete: removing a student cascades away their whole submission
  // mirror, which is unrecoverable from LeetCode's 20-row window.
  const orphans = await prisma.student.findMany({
    where: { batchId: batch.id, email: { notIn: [...mentionedEmails] } },
    select: { name: true, email: true },
  });

  console.log(`\n  created: ${created}`);
  console.log(`  updated: ${updated}`);
  if (failures.length > 0) {
    console.log(`  failed:  ${failures.length}`);
    for (const failure of failures) console.warn(`    ${failure}`);
  }
  if (orphans.length > 0) {
    console.log(`\n  ${orphans.length} student(s) in "${batch.name}" are not in this roster:`);
    for (const orphan of orphans) console.log(`    ${orphan.name} <${orphan.email}>`);
    console.log('  They were left untouched. Remove them from the admin panel if they have left.');
  }

  console.log('\nRoster load complete. Run a sync to pull their LeetCode history.');
}

main()
  .catch((error) => {
    console.error('Roster load failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
