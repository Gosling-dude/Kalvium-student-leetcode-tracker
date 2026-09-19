/**
 * Infosys reconciliation (§16): compare the tracker's stored solved/attempted rows
 * against an independent, live fetch from LeetCode for the same students. Read-only —
 * this never writes anything, including on a mismatch; it reports what it found and
 * leaves the decision to a human, exactly like `smoke-provider.ts` is a live check kept
 * deliberately out of the automated suite.
 *
 * This is not a substitute for `InfosysRollupService` — that is still the only writer
 * of `InfosysDailyStatus`/`InfosysDailyProblemStatus`. This script exists because the
 * program brief is explicit: "Never assume existing aggregates are correct." A rollup
 * that always agrees with itself proves the rollup is consistent, not that it is right;
 * this checks it against a source the rollup does not control.
 *
 * Run with:
 *   npm run infosys:reconcile -w @dsa/api -- --limit=10
 *   npm run infosys:reconcile -w @dsa/api -- --studentId=<uuid>
 *   npm run infosys:reconcile -w @dsa/api -- --all       (every enrolled, linked student —
 *                                                          this makes one live LeetCode
 *                                                          call per student; expect it to
 *                                                          take a while and be rate-limited)
 *
 * Known, disclosed limitation this script cannot work around: LeetCode's public
 * "recent submissions" endpoint exposes only the newest ~20 rows per user (see
 * `ProviderSubmissionPage.truncated`). A student who has solved many problems since
 * the tracker last synced can have older, still-in-window Infosys solves fall outside
 * that live window — this script flags `truncated: true` in that case rather than
 * treating "not found in the live fetch" as proof of anything.
 */

import { PrismaClient } from '@prisma/client';
import { evaluateInfosysDay, type InfosysAssignedProblemRef } from '@dsa/shared';

import { loadConfiguration } from '../src/config/configuration';
import { LeetCodeProvider } from '../src/modules/providers/leetcode/leetcode.provider';
import { isProviderError } from '../src/modules/providers/provider.errors';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  return process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=')[1];
}

async function main(): Promise<void> {
  const config = loadConfiguration();
  const provider = new LeetCodeProvider(config);

  const singleStudentId = arg('studentId');
  const all = process.argv.includes('--all');
  const limit = all ? Infinity : Number.parseInt(arg('limit') ?? '10', 10);

  const trackingStart = await prisma.infosysAssignment.findFirst({
    orderBy: { dayKey: 'asc' },
    select: { dayKey: true },
  });
  if (!trackingStart) {
    console.log('No Infosys assignments exist yet — nothing to reconcile.');
    return;
  }
  const trackingStartAt = new Date(`${trackingStart.dayKey}T00:00:00.000Z`);

  const assignments = await prisma.infosysAssignment.findMany({
    include: { problems: { include: { problem: true } } },
  });
  const allAssigned: InfosysAssignedProblemRef[] = assignments.flatMap((a) =>
    a.problems.map((p) => ({ problemId: p.problem.id, titleSlug: p.problem.titleSlug, position: p.position })),
  );
  if (allAssigned.length === 0) {
    console.log('No Infosys problems assigned yet — nothing to reconcile.');
    return;
  }

  const enrollments = await prisma.infosysEnrollment.findMany({
    where: {
      studentId: singleStudentId ?? undefined,
      student: { leetcodeUsername: { not: null } },
    },
    include: { student: { select: { id: true, name: true, leetcodeUsername: true } } },
    take: Number.isFinite(limit) ? limit : undefined,
  });

  if (enrollments.length === 0) {
    console.log('No Infosys students with a linked LeetCode profile matched the given filters.');
    return;
  }

  console.log(`\nInfosys reconciliation — ${enrollments.length} student(s), tracking start ${trackingStart.dayKey}\n`);

  let matches = 0;
  let staleTracker = 0; // live shows solved, stored does not
  let staleClaim = 0; // stored shows solved, live does not
  let truncatedCount = 0;
  let errors = 0;

  for (const enrollment of enrollments) {
    const username = enrollment.student.leetcodeUsername!;
    try {
      const live = await provider.fetchRecentSubmissions(username, { includeNonAccepted: true, limit: 100 });
      if (live.truncated) truncatedCount += 1;

      const liveOutcomes = evaluateInfosysDay(
        allAssigned,
        live.submissions.map((s) => ({ titleSlug: s.titleSlug, status: s.status, submittedAt: s.submittedAt })),
        trackingStartAt,
      );
      const liveSolved = new Set(liveOutcomes.filter((o) => o.status === 'SOLVED').map((o) => o.problemId));

      const stored = await prisma.infosysDailyProblemStatus.findMany({
        where: { infosysDailyStatus: { studentId: enrollment.studentId }, status: 'SOLVED' },
        select: { problemId: true },
      });
      const storedSolved = new Set(stored.map((s) => s.problemId));

      const onlyLive = [...liveSolved].filter((id) => !storedSolved.has(id));
      const onlyStored = [...storedSolved].filter((id) => !liveSolved.has(id));

      if (onlyLive.length === 0 && onlyStored.length === 0) {
        matches += 1;
        console.log(`MATCH  ${enrollment.student.name.padEnd(30)} (${username})`);
        continue;
      }

      if (onlyLive.length > 0) {
        staleTracker += 1;
        console.log(
          `STALE TRACKER  ${enrollment.student.name.padEnd(30)} (${username}) — live shows ${onlyLive.length} ` +
            'solved problem(s) not yet in the tracker. Run recomputeStudent or wait for the next sync.',
        );
      }
      if (onlyStored.length > 0) {
        staleClaim += 1;
        console.log(
          `⚠ POSSIBLE OVER-CLAIM  ${enrollment.student.name.padEnd(30)} (${username}) — tracker shows ` +
            `${onlyStored.length} solved problem(s) the live fetch does not confirm.` +
            (live.truncated
              ? ' Live fetch was truncated (LeetCode’s ~20-row window) — cannot conclude this is wrong.'
              : ' Live fetch was NOT truncated — this is worth investigating.'),
        );
      }
    } catch (error) {
      errors += 1;
      const reason = isProviderError(error) ? error.message : (error as Error).message;
      console.log(`ERROR  ${enrollment.student.name.padEnd(30)} (${username}) — ${reason}`);
    }
  }

  console.log('\nSummary');
  console.log(`  Matched:                ${matches}`);
  console.log(`  Stale tracker:          ${staleTracker}`);
  console.log(`  Possible over-claims:   ${staleClaim}`);
  console.log(`  Live fetch truncated:   ${truncatedCount}`);
  console.log(`  Errors:                 ${errors}`);
}

main()
  .catch((error) => {
    console.error('\nReconciliation failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
