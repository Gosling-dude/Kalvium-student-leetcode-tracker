/**
 * Coding-Hours daily assignment bulk-load, 22 September 2026 source sheet.
 *
 * The brief supplied a prep spreadsheet with one tab per campus/batch (ALU Foundation,
 * ALU Intermediate, SRM Foundation, VELS Foundation, VELS Intermediate — the "Infosys
 * Practice" tab is out of scope here, it is the Infosys Preparation schedule and already
 * fully seeded by `infosys-schedule-seed-2026-09.ts`). Verified against production
 * before this file was written: SRM had rows through 19 Sep, ALU through 21 Sep, VELS
 * Foundation only through 10 Sep and VELS Intermediate only through 12 Sep — the gap the
 * sheet exists to close, not evidence anything was ever broken. `ROWS` below is therefore
 * *only* the dates genuinely missing from each campus/batch, cross-checked day by day.
 *
 * Unlike the Infosys scripts, this one goes through the real `AssignmentsService.create`
 * (via a Nest application context, the same pattern `src/jobs/cron.ts` already uses for
 * out-of-process runs) rather than raw Prisma writes — Coding-Hours assignment creation
 * has real side effects a raw insert would skip: problem-metadata resolution/caching,
 * clash detection, and `reconcileAssignmentDay` (recomputes `DailyStatus` immediately, so
 * a newly-entered day does not sit stale for up to three hours). This also makes the
 * script's own safety check exact and current, not a snapshot taken while writing it: a
 * clash throws, is caught, and that row is skipped and reported rather than failing the
 * whole run.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx apps/api/scripts/coding-hours-schedule-seed-2026-09.ts            # dry run
 *   DATABASE_URL=... npx tsx apps/api/scripts/coding-hours-schedule-seed-2026-09.ts --apply     # write
 *
 * Take a backup first:
 *   pg_dump -Fc "$DATABASE_URL" > tmp/backups/pre-coding-hours-schedule-seed-<stamp>.dump
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

import { AppModule } from '../src/app.module';
import { AssignmentsService } from '../src/modules/assignments/assignments.service';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

interface Row {
  dayKey: string;
  campusCode: 'ALLIANCE' | 'SRM' | 'VELS';
  /** Batch code within the campus, or `null` for a whole-campus row (SRM's existing
   * convention — every SRM assignment in production today has `batchId: null`). */
  batchCode: 'Foundation Level' | 'Intermediate Level' | null;
  problemUrls: string[];
}

const ROWS: Row[] = [
  // --- ALU Foundation (missing: DB had nothing past 21 Sep) ---
  { dayKey: '2026-09-22', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/valid-parentheses/', 'https://leetcode.com/problems/implement-stack-using-queues/', 'https://leetcode.com/problems/implement-queue-using-stacks/', 'https://leetcode.com/problems/min-stack/'] },
  { dayKey: '2026-09-23', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/baseball-game/', 'https://leetcode.com/problems/remove-all-adjacent-duplicates-in-string/', 'https://leetcode.com/problems/backspace-string-compare/', 'https://leetcode.com/problems/asteroid-collision/'] },
  { dayKey: '2026-09-24', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/next-greater-element-i/', 'https://leetcode.com/problems/number-of-recent-calls/', 'https://leetcode.com/problems/daily-temperatures/', 'https://leetcode.com/problems/next-greater-element-ii/'] },
  { dayKey: '2026-09-25', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/design-circular-queue/', 'https://leetcode.com/problems/design-circular-deque/', 'https://leetcode.com/problems/online-stock-span/', 'https://leetcode.com/problems/sliding-window-maximum/'] },
  { dayKey: '2026-09-26', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/evaluate-reverse-polish-notation/', 'https://leetcode.com/problems/simplify-path/', 'https://leetcode.com/problems/decode-string/', 'https://leetcode.com/problems/basic-calculator-ii/'] },
  { dayKey: '2026-09-28', campusCode: 'ALLIANCE', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/remove-k-digits/', 'https://leetcode.com/problems/car-fleet/', 'https://leetcode.com/problems/largest-rectangle-in-histogram/', 'https://leetcode.com/problems/trapping-rain-water/'] },

  // --- ALU Intermediate (missing: DB had nothing past 21 Sep) ---
  { dayKey: '2026-09-22', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/fibonacci-number/', 'https://leetcode.com/problems/reverse-string/', 'https://leetcode.com/problems/power-of-two/', 'https://leetcode.com/problems/powx-n/'] },
  { dayKey: '2026-09-23', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/climbing-stairs/', 'https://leetcode.com/problems/reverse-linked-list/', 'https://leetcode.com/problems/merge-two-sorted-lists/', 'https://leetcode.com/problems/k-th-symbol-in-grammar/'] },
  { dayKey: '2026-09-24', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/maximum-depth-of-binary-tree/', 'https://leetcode.com/problems/same-tree/', 'https://leetcode.com/problems/binary-tree-paths/', 'https://leetcode.com/problems/path-sum-ii/'] },
  { dayKey: '2026-09-25', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/binary-watch/', 'https://leetcode.com/problems/letter-case-permutation/', 'https://leetcode.com/problems/subsets/', 'https://leetcode.com/problems/subsets-ii/'] },
  { dayKey: '2026-09-26', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/combinations/', 'https://leetcode.com/problems/permutations/', 'https://leetcode.com/problems/combination-sum/', 'https://leetcode.com/problems/generate-parentheses/'] },
  { dayKey: '2026-09-27', campusCode: 'ALLIANCE', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/letter-combinations-of-a-phone-number/', 'https://leetcode.com/problems/palindrome-partitioning/', 'https://leetcode.com/problems/word-search/', 'https://leetcode.com/problems/n-queens/'] },

  // --- SRM (whole-campus, no batch split — matches every existing SRM row) ---
  { dayKey: '2026-09-21', campusCode: 'SRM', batchCode: null, problemUrls: ['https://leetcode.com/problems/find-smallest-letter-greater-than-target/', 'https://leetcode.com/problems/check-if-a-number-is-majority-element-in-a-sorted-array/', 'https://leetcode.com/problems/kth-missing-positive-number/', 'https://leetcode.com/problems/find-target-indices-after-sorting-array/'] },
  { dayKey: '2026-09-22', campusCode: 'SRM', batchCode: null, problemUrls: ['https://leetcode.com/problems/count-negative-numbers-in-a-sorted-matrix/', 'https://leetcode.com/problems/find-the-distance-value-between-two-arrays/', 'https://leetcode.com/problems/find-the-pivot-integer/', 'https://leetcode.com/problems/element-appearing-more-than-25-in-sorted-array/'] },
  { dayKey: '2026-09-23', campusCode: 'SRM', batchCode: null, problemUrls: ['https://leetcode.com/problems/maximum-count-of-positive-integer-and-negative-integer/', 'https://leetcode.com/problems/minimum-distance-to-the-target-element/', 'https://leetcode.com/problems/find-all-k-distant-indices-in-an-array/', 'https://leetcode.com/problems/two-sum-less-than-k/'] },
  { dayKey: '2026-09-24', campusCode: 'SRM', batchCode: null, problemUrls: ['https://leetcode.com/problems/minimum-common-value/', 'https://leetcode.com/problems/intersection-of-multiple-arrays/', 'https://leetcode.com/problems/check-if-an-array-is-consecutive/', 'https://leetcode.com/problems/find-closest-number-to-zero/'] },
  { dayKey: '2026-09-25', campusCode: 'SRM', batchCode: null, problemUrls: ['https://leetcode.com/problems/range-sum-query-immutable/', 'https://leetcode.com/problems/two-out-of-three/', 'https://leetcode.com/problems/contains-duplicate-ii/', 'https://leetcode.com/problems/distribute-candies/'] },

  // --- VELS Foundation (missing: DB had nothing past 10 Sep) ---
  { dayKey: '2026-09-21', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/fibonacci-number/', 'https://leetcode.com/problems/reverse-string/', 'https://leetcode.com/problems/power-of-two/', 'https://leetcode.com/problems/powx-n/'] },
  { dayKey: '2026-09-22', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/climbing-stairs/', 'https://leetcode.com/problems/reverse-linked-list/', 'https://leetcode.com/problems/merge-two-sorted-lists/', 'https://leetcode.com/problems/k-th-symbol-in-grammar/'] },
  { dayKey: '2026-09-23', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/maximum-depth-of-binary-tree/', 'https://leetcode.com/problems/same-tree/', 'https://leetcode.com/problems/binary-tree-paths/', 'https://leetcode.com/problems/path-sum-ii/'] },
  { dayKey: '2026-09-24', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/binary-watch/', 'https://leetcode.com/problems/letter-case-permutation/', 'https://leetcode.com/problems/subsets/', 'https://leetcode.com/problems/subsets-ii/'] },
  { dayKey: '2026-09-25', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/combinations/', 'https://leetcode.com/problems/permutations/', 'https://leetcode.com/problems/combination-sum/', 'https://leetcode.com/problems/generate-parentheses/'] },
  { dayKey: '2026-09-26', campusCode: 'VELS', batchCode: 'Foundation Level', problemUrls: ['https://leetcode.com/problems/letter-combinations-of-a-phone-number/', 'https://leetcode.com/problems/palindrome-partitioning/', 'https://leetcode.com/problems/word-search/', 'https://leetcode.com/problems/n-queens/'] },

  // --- VELS Intermediate (7-12 Sep already exist in production; only 21-26 Sep are missing) ---
  { dayKey: '2026-09-21', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/sum-of-all-subset-xor-totals/', 'https://leetcode.com/problems/power-of-two/', 'https://leetcode.com/problems/generate-parentheses/', 'https://leetcode.com/problems/beautiful-arrangement/'] },
  { dayKey: '2026-09-22', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/power-of-three/', 'https://leetcode.com/problems/pascals-triangle/', 'https://leetcode.com/problems/letter-tile-possibilities/', 'https://leetcode.com/problems/count-number-of-maximum-bitwise-or-subsets/'] },
  { dayKey: '2026-09-23', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/power-of-four/', 'https://leetcode.com/problems/number-of-steps-to-reduce-a-number-to-zero/', 'https://leetcode.com/problems/letter-case-permutation/', 'https://leetcode.com/problems/numbers-with-same-consecutive-differences/'] },
  { dayKey: '2026-09-24', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/add-digits/', 'https://leetcode.com/problems/happy-number/', 'https://leetcode.com/problems/target-sum/', 'https://leetcode.com/problems/combination-sum/'] },
  { dayKey: '2026-09-25', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/sum-of-digits-in-base-k/', 'https://leetcode.com/problems/reverse-string/', 'https://leetcode.com/problems/permutations-ii/', 'https://leetcode.com/problems/subsets-ii/'] },
  { dayKey: '2026-09-26', campusCode: 'VELS', batchCode: 'Intermediate Level', problemUrls: ['https://leetcode.com/problems/climbing-stairs/', 'https://leetcode.com/problems/ugly-number/', 'https://leetcode.com/problems/word-search/', 'https://leetcode.com/problems/restore-ip-addresses/'] },
];

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  // --- Integrity, before touching anything ---------------------------------------
  const seen = new Set<string>();
  for (const row of ROWS) {
    const key = `${row.dayKey}|${row.campusCode}|${row.batchCode ?? 'ALL'}`;
    if (seen.has(key)) throw new Error(`Duplicate row in ROWS: ${key}`);
    seen.add(key);
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('No ADMIN user exists to attribute these assignments to. Refusing.');
  console.log(`  Attributing to: ${admin.email} (${admin.id})\n`);

  const campuses = await prisma.campus.findMany({ where: { code: { in: ['ALLIANCE', 'SRM', 'VELS'] } } });
  const campusIdByCode = new Map(campuses.map((c) => [c.code, c.id]));
  for (const code of ['ALLIANCE', 'SRM', 'VELS']) {
    if (!campusIdByCode.has(code)) throw new Error(`Campus code "${code}" does not exist. Refusing.`);
  }

  const batches = await prisma.batch.findMany({
    where: { campusId: { in: [...campusIdByCode.values()] }, status: 'ACTIVE' },
  });
  const batchIdByCampusAndName = new Map<string, string>();
  for (const b of batches) batchIdByCampusAndName.set(`${b.campusId}|${b.name}`, b.id);

  const app = await NestFactory.createApplicationContext(AppModule);
  const assignments = app.get(AssignmentsService);

  let created = 0;
  let alreadyExisted = 0;
  let failed = 0;

  try {
    for (const row of ROWS) {
      const campusId = campusIdByCode.get(row.campusCode)!;
      const batchId = row.batchCode ? batchIdByCampusAndName.get(`${campusId}|${row.batchCode}`) : undefined;
      if (row.batchCode && !batchId) {
        console.log(`  ${row.dayKey} ${row.campusCode}/${row.batchCode}: no such active batch — SKIPPED`);
        failed += 1;
        continue;
      }

      const label = `${row.dayKey} ${row.campusCode}${row.batchCode ? '/' + row.batchCode : ' (all batches)'}`;

      if (!APPLY) {
        // Dry run: report whether it would clash, without writing.
        const existing = await prisma.assignment.findFirst({
          where: { dayKey: row.dayKey, campusId, batchId: batchId ?? null },
        });
        console.log(existing ? `  ${label}: already exists — would skip` : `  ${label}: would create (${row.problemUrls.length} problems)`);
        continue;
      }

      try {
        await assignments.create(
          { dayKey: row.dayKey, campus: campusId, batches: batchId ? [batchId] : undefined, problemUrls: row.problemUrls },
          admin.id,
        );
        console.log(`  ${label}: created`);
        created += 1;
      } catch (error) {
        if (error instanceof BadRequestException) {
          console.log(`  ${label}: already exists — skipped (${(error as Error).message})`);
          alreadyExisted += 1;
          continue;
        }
        console.error(`  ${label}: FAILED — ${(error as Error).message}`);
        failed += 1;
      }
    }
  } finally {
    await app.close();
  }

  console.log('\nSummary');
  console.log(`  Rows in schedule: ${ROWS.length}`);
  if (APPLY) {
    console.log(`  Created: ${created}`);
    console.log(`  Already existed (skipped): ${alreadyExisted}`);
    console.log(`  Failed: ${failed}`);
  } else {
    console.log('\nNothing was written. Re-run with --apply.');
  }
}

main()
  .catch((error: Error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
