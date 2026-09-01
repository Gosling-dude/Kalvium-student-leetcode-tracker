/**
 * Repair batch placements that were recorded as "effective today" when they were in fact
 * a student's *first* classification.
 *
 * ## What went wrong
 *
 * `BatchesService.moveStudent` and the bulk reassignment path both dated every history row
 * `today`, without asking whether the student had any prior placement. That is right for a
 * genuine move and wrong for a first classification: dividing an unclassified cohort into
 * batches states what has been true since enrolment, it does not change anything as of
 * today. Dating it "today" leaves every earlier day resolving to "no batch", so a
 * batch-scoped assignment published before the split matches nobody — `selectAssignmentForScope`
 * cannot pair a batch-targeted assignment with a student who had no batch — and those days
 * score `assignedCount = 0` for the whole cohort.
 *
 * The code defect is fixed in `BatchesService.defaultPlacementDay`, which now defers to the
 * shared `resolvePlacementEffectiveDate` rule. This script repairs the rows already written.
 *
 * ## What it does
 *
 * For every student, take their **earliest** placement row. If it is a first placement
 * (`fromBatchId IS NULL`) dated later than the student's enrolment day, move its
 * `effectiveFromDayKey` back to that enrolment day. Nothing else is touched: later moves
 * keep their own dates, no row is created or deleted, and no submission, daily status or
 * assignment is read or written.
 *
 * Idempotent: a second run finds nothing to do, because the repaired rows now sit on the
 * enrolment day and fail the `> enrolment` test.
 *
 * Recomputing the affected days is deliberately *not* part of this script — that runs
 * separately via `POST /admin/recompute` with `force`, so the data repair and the
 * (much longer) rescoring can be reviewed and retried independently.
 *
 *   npm run db:backfill:placements -w @dsa/api            # report only
 *   npm run db:backfill:placements -w @dsa/api -- --apply # write
 */

import { PrismaClient } from '@prisma/client';
import { DEFAULT_PROGRAM_TIMEZONE, toDayKey } from '@dsa/shared';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const TIMEZONE = process.env.PROGRAM_TIMEZONE ?? DEFAULT_PROGRAM_TIMEZONE;

async function main(): Promise<void> {
  const students = await prisma.student.findMany({
    select: {
      id: true,
      name: true,
      createdAt: true,
      campus: { select: { code: true } },
      batchHistory: {
        select: {
          id: true,
          fromBatchId: true,
          toBatchId: true,
          effectiveFromDayKey: true,
          changedAt: true,
        },
        // Earliest first, with `changedAt` breaking a same-day tie the same way
        // `resolveBatchOnDay` does.
        orderBy: [{ effectiveFromDayKey: 'asc' }, { changedAt: 'asc' }],
      },
    },
  });

  const repairs: {
    rowId: string;
    studentName: string;
    campus: string;
    from: string;
    to: string;
  }[] = [];

  for (const student of students) {
    const earliest = student.batchHistory[0];
    if (!earliest) continue;
    // Only a first classification is back-dated. A row with a `fromBatchId` is a real
    // move away from a batch the student was already in, and its date is a fact.
    if (earliest.fromBatchId !== null) continue;

    const enrolmentDayKey = toDayKey(student.createdAt, TIMEZONE);
    if (earliest.effectiveFromDayKey <= enrolmentDayKey) continue;

    repairs.push({
      rowId: earliest.id,
      studentName: student.name,
      campus: student.campus?.code ?? '(no campus)',
      from: earliest.effectiveFromDayKey,
      to: enrolmentDayKey,
    });
  }

  if (repairs.length === 0) {
    console.log('Nothing to repair — every first placement already dates from enrolment.');
    return;
  }

  const byCampus = new Map<string, number>();
  for (const repair of repairs) {
    byCampus.set(repair.campus, (byCampus.get(repair.campus) ?? 0) + 1);
  }

  console.log(`${repairs.length} first placement(s) dated after enrolment:`);
  for (const [campus, count] of [...byCampus].sort()) {
    console.log(`  ${campus.padEnd(10)} ${count}`);
  }
  const earliestRepairedDay = repairs.reduce((min, r) => (r.to < min ? r.to : min), repairs[0]!.to);
  console.log(`Earliest day that becomes scoreable again: ${earliestRepairedDay}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write these changes.');
    return;
  }

  // One statement per row: `updateMany` cannot set a different value per row, and the
  // volume here is a cohort, not a table scan.
  let applied = 0;
  for (const repair of repairs) {
    await prisma.studentBatchHistory.update({
      where: { id: repair.rowId },
      data: { effectiveFromDayKey: repair.to },
    });
    applied += 1;
  }

  console.log(`\nBack-dated ${applied} placement row(s).`);
  console.log(
    `Now recompute from ${earliestRepairedDay} with force so the affected days pick up ` +
      'the batch and its assignment.',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
