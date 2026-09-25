/**
 * Attempts Analysis diagnostic — read-only.
 *
 * For one student (and optionally one assignment day and/or problem), prints what the
 * Attempts Analysis is built from and what it concludes, side by side:
 *
 *   assignment record(s) -> problem slug -> LeetCode username -> every mirrored
 *   submission to that slug (id, time, verdict, in/out of the assignment period)
 *   -> attempts / failed / accepted / first accepted / outcome, as computed by the same
 *   `CampusAttemptsService` the page and the exports call.
 *
 * Nothing is written and no LeetCode call is made. No credential is printed.
 *
 * Run with:
 *   (cd apps/api && DATABASE_URL=... npx tsx scripts/attempts-diagnose.ts --student "Abishek R V")
 *   (cd apps/api && DATABASE_URL=... npx tsx scripts/attempts-diagnose.ts --student abishek2208 --day 2026-08-06)
 *   (cd apps/api && DATABASE_URL=... npx tsx scripts/attempts-diagnose.ts --student <uuid> --problem maximum-erasure-value)
 *
 * `--student` matches an id, a LeetCode username, or a case-insensitive name fragment
 * (active students only; ambiguous matches are listed rather than guessed).
 */

import { PrismaClient } from '@prisma/client';

import { CampusAnalysisService } from '../src/modules/analytics/campus-analysis.service';
import { CampusAttemptsService } from '../src/modules/analytics/campus-attempts.service';
import { CampusesService } from '../src/modules/campuses/campuses.service';
import { MentorScopeService } from '../src/modules/campuses/mentor-scope.service';
import { ProgramTimeService } from '../src/common/services/program-time.service';
import type { RequestUser } from '../src/common/decorators';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const prisma = new PrismaClient();
const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const mentorScope = new MentorScopeService(prisma as never);
const cache = { remember: (_key: string, _ttl: number, fn: () => unknown) => fn() } as never;
const campuses = new CampusesService(prisma as never, time, cache, mentorScope);
const attempts = new CampusAttemptsService(prisma as never, time, new CampusAnalysisService(prisma as never, time, mentorScope, campuses));
const admin = { id: '', email: 'diagnostic@local', name: 'Diagnostic', role: 'ADMIN', studentId: null } as RequestUser;

const ist = (d: Date | string | null) =>
  d ? `${time.dayKeyOf(new Date(d))} ${new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })} IST` : '—';

async function main(): Promise<void> {
  const needle = arg('student');
  const day = arg('day');
  const problem = arg('problem')?.toLowerCase() ?? null;
  if (!needle) throw new Error('--student is required (id, LeetCode username or name fragment).');

  const uuid = /^[0-9a-f-]{36}$/i.test(needle);
  const candidates = await prisma.student.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        ...(uuid ? [{ id: needle }] : []),
        { leetcodeUsername: { equals: needle, mode: 'insensitive' as const } },
        { name: { contains: needle, mode: 'insensitive' as const } },
      ],
    },
    select: {
      id: true,
      name: true,
      leetcodeUsername: true,
      campus: { select: { code: true } },
      batch: { select: { name: true } },
      syncState: { select: { status: true, lastSuccessAt: true, lastError: true } },
    },
  });
  if (candidates.length !== 1) {
    console.log(`${candidates.length} active students match "${needle}":`);
    for (const c of candidates) console.log(`  ${c.id}  ${c.name}  ${c.leetcodeUsername ?? '(no handle)'}  ${c.campus?.code ?? ''}`);
    return;
  }
  const student = candidates[0]!;
  console.log(`Student      ${student.name} (${student.id})`);
  console.log(`Campus/batch ${student.campus?.code ?? '—'} / ${student.batch?.name ?? '—'}`);
  console.log(`LeetCode     ${student.leetcodeUsername ?? '(none linked)'}`);
  console.log(
    `Sync         ${student.syncState?.status ?? 'NEVER_SYNCED'}, last success ${ist(student.syncState?.lastSuccessAt ?? null)}` +
      (student.syncState?.lastError ? ` — ${student.syncState.lastError}` : ''),
  );

  const result = await attempts.student(admin, student.id, day ? { from: day, to: day } : {});
  const rows = result.rows.filter((r) => !problem || r.titleSlug === problem);
  if (rows.length === 0) {
    console.log('\nNo assigned problem matches these filters.');
    return;
  }

  for (const row of rows.sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.position - b.position)) {
    const assignment = await prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: student.id, dayKey: row.dayKey } },
      select: { assignment: { select: { id: true, dayKey: true, campus: { select: { code: true } }, batch: { select: { name: true } } } } },
    });
    const mirrored = await prisma.submission.findMany({
      where: { studentId: student.id, titleSlug: { equals: row.titleSlug, mode: 'insensitive' } },
      orderBy: { submittedAt: 'asc' },
      select: { providerSubmissionId: true, status: true, submittedAt: true, dayKey: true, language: true },
    });
    const counted = new Set(row.submissions.map((s) => s.providerSubmissionId));
    const a = assignment?.assignment;
    console.log(`\n=== ${row.dayKey}  #${row.position}  ${row.titleSlug}  (${row.difficulty ?? '—'})`);
    console.log(
      `Assignment   ${a ? `${a.id} dated ${a.dayKey}, target ${a.campus?.code ?? 'all campuses'} / ${a.batch?.name ?? 'all batches'}` : '—'}`,
    );
    console.log(`Period       ${row.dayKey} .. ${row.windowEndDayKey ?? 'open (not assigned again)'}`);
    console.log(`Mirrored     ${mirrored.length} submission(s) to this slug, any date:`);
    for (const s of mirrored) {
      console.log(
        `  ${counted.has(s.providerSubmissionId) ? 'COUNTED ' : 'outside '} ${s.providerSubmissionId.padEnd(11)} ${ist(s.submittedAt)}  ${s.status.padEnd(22)} ${s.language ?? ''}`,
      );
    }
    console.log(
      `Result       attempts=${row.attempts} failed=${row.failedAttempts} accepted=${row.submissions.filter((s) => s.status === 'ACCEPTED').length} ` +
        `firstAttempt=${ist(row.firstAttemptAt)} firstAccepted=${ist(row.firstAcceptedAt)} lastAttempt=${ist(row.lastAttemptAt)}`,
    );
    console.log(`Outcome      ${row.outcome}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
