/**
 * Coding Hours roster change of 16 September 2026.
 *
 * One student returns to the active population and four leave it. Both halves are data
 * operations on production, so this exists as a script rather than a migration: it is
 * reversible, it reports what it is about to do before it does it, and running it twice
 * changes nothing the second time.
 *
 *   npx tsx apps/api/scripts/roster-change-2026-09-16.ts            # dry run, the default
 *   npx tsx apps/api/scripts/roster-change-2026-09-16.ts --apply    # write
 *
 * Take a backup first. `pg_dump -Fc "$DATABASE_URL" > tmp/backups/pre-roster-<stamp>.dump`.
 *
 * ## Why every target is addressed by email
 *
 * Four of the five names given are ambiguous against the live roster, and two of the
 * ambiguities would have archived the wrong person:
 *
 *   "Vignesh Rahul" matches **Vigneshrahul** (squad 75, rahul-cv) and also **Vignesh R**
 *   (squad 74, vignesh_5605) — a different student who is still in the programme.
 *
 *   "Yogeshwar" matches **P. Yogeshwar** (squad 75, yogiii_07) and also **Yogeshwaran M**
 *   (squad 74, yogeshhhhhh) — a different student, and one of the more active ones.
 *
 * A name match would have been a coin toss on both. Email is the one identifier that is
 * unique per student in this dataset, so it is what the script keys on; the handle and
 * squad recorded beside it are re-checked before anything is written, and a mismatch
 * aborts rather than proceeding on the assumption that the email was right.
 *
 * ## What archiving does and does not do
 *
 * `status = ARCHIVED` removes a student from every active list, from active-student
 * analytics and from future assignment audiences. It deletes nothing: submissions, daily
 * statuses, assignment results, baseline attempts, campus and batch history, mentor notes
 * and leaderboard rows all stay exactly as they are, and historical reports continue to
 * read them. That is why archiving is the right instrument here and deletion is not.
 */

import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

interface Target {
  /** The unique identifier. Names in this dataset are not unique; emails are. */
  email: string;
  /** Re-checked before writing — a mismatch means the roster moved under us. */
  expect: { name: string; leetcodeUsername: string; squad: string; campus: string };
  /** Named in the request, and the reason both are recorded in the audit trail. */
  requestedAs: string;
  /** Who this must NOT be confused with, and why the distinction matters. */
  notToBeConfusedWith?: string;
}

const TO_ARCHIVE: Target[] = [
  {
    email: 'yashika.sridhar.s74@kalvium.community',
    expect: { name: 'Yashika Sridhar', leetcodeUsername: 'yashika_sridhar', squad: '74', campus: 'VELS' },
    requestedAs: 'Yashika Sridhar',
  },
  {
    email: 'sharon.emmanuel.s.r.s75@kalvium.community',
    expect: { name: 'Sharon Emmaunel S. R', leetcodeUsername: 'sharon_emmanuel', squad: '75', campus: 'VELS' },
    requestedAs: 'Sharon',
  },
  {
    email: 'vigneshrahul.c.s75@kalvium.community',
    expect: { name: 'Vigneshrahul', leetcodeUsername: 'rahul-cv', squad: '75', campus: 'VELS' },
    requestedAs: 'Vignesh Rahul',
    notToBeConfusedWith: 'Vignesh R (squad 74, vignesh_5605) — a different, still-active student',
  },
  {
    email: 'yogeshwar.p.s75@kalvium.community',
    expect: { name: 'P. Yogeshwar', leetcodeUsername: 'yogiii_07', squad: '75', campus: 'VELS' },
    requestedAs: 'Yogeshwar',
    notToBeConfusedWith: 'Yogeshwaran M (squad 74, yogeshhhhhh) — a different, still-active student',
  },
];

const TO_REACTIVATE: Target = {
  email: 'lithishwaran.v.s75@kalvium.community',
  expect: { name: 'Lithishwaran V', leetcodeUsername: 'lithishvivek', squad: '75', campus: 'VELS' },
  requestedAs: 'Lithishwaran V',
};

const ARCHIVE_REASON = 'Removed from active Coding Hours, 2026-09-16. History retained.';

type Loaded = Prisma.StudentGetPayload<{ include: { squad: true; campus: true } }>;

async function load(target: Target): Promise<Loaded> {
  const student = await prisma.student.findFirst({
    where: { email: { equals: target.email, mode: 'insensitive' } },
    include: { squad: true, campus: true },
  });
  if (!student) {
    throw new Error(
      `No student with email ${target.email} (requested as "${target.requestedAs}"). ` +
        'Refusing to fall back to a name match — see the header for why.',
    );
  }

  // The email found somebody; check it found the right somebody before touching them.
  const actual = {
    name: student.name,
    leetcodeUsername: student.leetcodeUsername ?? '',
    squad: student.squad?.name ?? '',
    campus: student.campus?.code ?? '',
  };
  const drift = (Object.keys(target.expect) as (keyof typeof target.expect)[])
    .filter((k) => actual[k].toLowerCase() !== target.expect[k].toLowerCase())
    .map((k) => `${k}: expected "${target.expect[k]}", found "${actual[k]}"`);
  if (drift.length > 0) {
    throw new Error(
      `${target.email} is not the record this change was reviewed against — ${drift.join('; ')}. ` +
        'Re-verify against the live roster before running.',
    );
  }
  return student;
}

/** Every similarly-named student, so the operator can see what was *not* touched. */
async function nearMisses(target: Target): Promise<string[]> {
  const firstWord = target.requestedAs.split(/\s+/)[0]!;
  const rows = await prisma.student.findMany({
    where: { name: { contains: firstWord, mode: 'insensitive' }, email: { not: target.email } },
    include: { squad: true },
    orderBy: { name: 'asc' },
  });
  return rows.map(
    (r) => `${r.name} (squad ${r.squad?.name ?? '—'}, ${r.leetcodeUsername ?? 'no handle'}, ${r.status})`,
  );
}

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  console.log('--- Reactivate ---');
  const lith = await load(TO_REACTIVATE);
  console.log(`  ${lith.name} <${lith.email}>`);
  console.log(`    campus ${lith.campus?.code}  squad ${lith.squad?.name}  handle ${lith.leetcodeUsername}`);
  console.log(`    status ${lith.status}${lith.archivedAt ? ` since ${lith.archivedAt.toISOString().slice(0, 10)}` : ''}`);
  console.log(`    reason on file: ${lith.archivedReason ?? '—'}`);
  const others = await nearMisses(TO_REACTIVATE);
  console.log(`    other "Lithish…" records: ${others.length === 0 ? 'none — no duplicate to merge' : others.join('; ')}`);
  if (lith.status === 'ACTIVE') {
    console.log('    already ACTIVE — nothing to do');
  } else if (APPLY) {
    await prisma.student.update({
      where: { id: lith.id },
      data: { status: 'ACTIVE', archivedAt: null, archivedReason: null },
    });
    // Force the next sync to re-read the profile rather than trusting a total cached
    // before the student left: they have been gone since 13 August.
    await prisma.studentSyncState.updateMany({
      where: { studentId: lith.id },
      data: { providerProfileFetchedAt: null },
    });
    console.log('    -> reactivated, profile cache invalidated for the next sync');
  } else {
    console.log('    -> would reactivate (status ACTIVE, archivedAt cleared) and invalidate the profile cache');
  }

  console.log('\n--- Archive out of active Coding Hours ---');
  for (const target of TO_ARCHIVE) {
    const student = await load(target);
    console.log(`\n  ${student.name} <${student.email}>  [requested as "${target.requestedAs}"]`);
    console.log(`    campus ${student.campus?.code}  squad ${student.squad?.name}  handle ${student.leetcodeUsername}`);
    if (target.notToBeConfusedWith) console.log(`    NOT: ${target.notToBeConfusedWith}`);
    console.log(`    similarly named on the roster: ${(await nearMisses(target)).join('; ') || 'none'}`);

    const [submissions, dailyStatuses, baselineAttempts] = await Promise.all([
      prisma.submission.count({ where: { studentId: student.id } }),
      prisma.dailyStatus.count({ where: { studentId: student.id } }),
      prisma.baselineTestAttempt.count({ where: { studentId: student.id } }),
    ]);
    console.log(`    history kept: ${submissions} submissions, ${dailyStatuses} daily statuses, ${baselineAttempts} baseline attempts`);

    if (student.status === 'ARCHIVED') {
      console.log('    already ARCHIVED — nothing to do');
    } else if (APPLY) {
      await prisma.student.update({
        where: { id: student.id },
        data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: ARCHIVE_REASON },
      });
      console.log('    -> archived (no rows deleted)');
    } else {
      console.log('    -> would archive (no rows deleted)');
    }
  }

  const active = await prisma.student.count({ where: { status: 'ACTIVE' } });
  console.log(`\nActive students ${APPLY ? 'now' : 'currently'}: ${active}`);
  if (!APPLY) console.log('Nothing was written. Re-run with --apply.');
}

main()
  .catch((error: Error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
