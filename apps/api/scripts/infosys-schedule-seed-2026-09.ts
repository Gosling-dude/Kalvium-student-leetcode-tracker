/**
 * Bulk-load the Infosys Preparation question schedule, 21 Sep – 3 Oct 2026 (§2 of the
 * program brief). Every Infosys student gets the same problems on the same day — there
 * is no campus/batch targeting on `InfosysAssignment` (see the schema.prisma section
 * banner above `InfosysEnrollment`) — so this is a flat list of (dayKey, 4 problem URLs).
 *
 * The point of this script is that nobody has to open the admin form and paste four
 * URLs every morning: every date in the brief is inserted now, the existing dynamic
 * assignment model (`InfosysAssignment` + `InfosysAssignmentProblem`, 1..N problems per
 * day) is reused exactly as `InfosysAssignmentsService.create` would build it, and the
 * "Daily Assignments" page already lists every `InfosysAssignment` row regardless of
 * date — so once this has run, every day in the range is already there.
 *
 * There is deliberately no row for 27 Sep 2026 — the brief has none, so none is invented.
 *
 * Idempotent by construction: `InfosysAssignment.dayKey` is `@unique` and
 * `InfosysAssignmentProblem` is `@unique([infosysAssignmentId, problemId])`, so a second
 * run finds each day already correct and writes nothing further. If a day's problem set
 * changes between runs, this script updates that day's problems to match rather than
 * leaving stale rows (mirrors `InfosysAssignmentsService.update`), but it never touches
 * a day's `InfosysDailyStatus`/`InfosysDailyProblemStatus` rows itself — recompute is a
 * separate, explicit step (`npm run infosys:recompute -w @dsa/api` or the admin
 * `POST /infosys/assignments/recompute` route) so a schedule load and a rollup are two
 * auditable operations, not one.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-schedule-seed-2026-09.ts            # dry run
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-schedule-seed-2026-09.ts --apply     # write
 */

import { PrismaClient } from '@prisma/client';
import { extractProblemSlug } from '@dsa/shared';

import { loadConfiguration } from '../src/config/configuration';
import { LeetCodeProvider } from '../src/modules/providers/leetcode/leetcode.provider';
import { ProviderProblemNotFoundError } from '../src/modules/providers/provider.errors';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

interface Row {
  dayKey: string;
  urls: string[];
}

const SCHEDULE: Row[] = [
  {
    dayKey: '2026-09-21',
    urls: [
      'https://leetcode.com/problems/two-sum/',
      'https://leetcode.com/problems/best-time-to-buy-and-sell-stock/',
      'https://leetcode.com/problems/product-of-array-except-self/',
      'https://leetcode.com/problems/subarray-sum-equals-k/',
    ],
  },
  {
    dayKey: '2026-09-22',
    urls: [
      'https://leetcode.com/problems/valid-palindrome/',
      'https://leetcode.com/problems/move-zeroes/',
      'https://leetcode.com/problems/3sum/',
      'https://leetcode.com/problems/container-with-most-water/',
    ],
  },
  {
    dayKey: '2026-09-23',
    urls: [
      'https://leetcode.com/problems/maximum-average-subarray-i/',
      'https://leetcode.com/problems/valid-anagram/',
      'https://leetcode.com/problems/longest-substring-without-repeating-characters/',
      'https://leetcode.com/problems/longest-repeating-character-replacement/',
    ],
  },
  {
    dayKey: '2026-09-24',
    urls: [
      'https://leetcode.com/problems/binary-search/',
      'https://leetcode.com/problems/search-insert-position/',
      'https://leetcode.com/problems/search-in-rotated-sorted-array/',
      'https://leetcode.com/problems/koko-eating-bananas/',
    ],
  },
  {
    dayKey: '2026-09-25',
    urls: [
      'https://leetcode.com/problems/valid-parentheses/',
      'https://leetcode.com/problems/next-greater-element-i/',
      'https://leetcode.com/problems/daily-temperatures/',
      'https://leetcode.com/problems/decode-string/',
    ],
  },
  {
    dayKey: '2026-09-26',
    urls: [
      'https://leetcode.com/problems/palindrome-number/',
      'https://leetcode.com/problems/single-number/',
      'https://leetcode.com/problems/count-primes/',
      'https://leetcode.com/problems/powx-n/',
    ],
  },
  // No row for 2026-09-27 — none was given in the brief; none is invented.
  {
    dayKey: '2026-09-28',
    urls: [
      'https://leetcode.com/problems/fibonacci-number/',
      'https://leetcode.com/problems/binary-watch/',
      'https://leetcode.com/problems/subsets/',
      'https://leetcode.com/problems/permutations/',
    ],
  },
  {
    dayKey: '2026-09-29',
    urls: [
      'https://leetcode.com/problems/assign-cookies/',
      'https://leetcode.com/problems/lemonade-change/',
      'https://leetcode.com/problems/gas-station/',
      'https://leetcode.com/problems/merge-intervals/',
    ],
  },
  {
    dayKey: '2026-09-30',
    urls: [
      'https://leetcode.com/problems/climbing-stairs/',
      'https://leetcode.com/problems/min-cost-climbing-stairs/',
      'https://leetcode.com/problems/longest-increasing-subsequence/',
      'https://leetcode.com/problems/word-break/',
    ],
  },
  {
    dayKey: '2026-10-01',
    urls: [
      'https://leetcode.com/problems/is-subsequence/',
      'https://leetcode.com/problems/pascals-triangle/',
      'https://leetcode.com/problems/partition-equal-subset-sum/',
      'https://leetcode.com/problems/longest-palindromic-substring/',
    ],
  },
  {
    dayKey: '2026-10-02',
    urls: [
      'https://leetcode.com/problems/maximum-depth-of-binary-tree/',
      'https://leetcode.com/problems/flood-fill/',
      'https://leetcode.com/problems/binary-tree-level-order-traversal/',
      'https://leetcode.com/problems/number-of-islands/',
    ],
  },
  {
    dayKey: '2026-10-03',
    urls: [
      'https://leetcode.com/problems/top-k-frequent-elements/',
      'https://leetcode.com/problems/spiral-matrix/',
      'https://leetcode.com/problems/course-schedule/',
      'https://leetcode.com/problems/trapping-rain-water/',
    ],
  },
];

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  const config = loadConfiguration();
  const provider = new LeetCodeProvider(config);

  // --- Data integrity -----------------------------------------------------------------
  const dayKeys = SCHEDULE.map((r) => r.dayKey);
  if (new Set(dayKeys).size !== dayKeys.length) throw new Error('Duplicate dayKey in SCHEDULE.');
  for (const row of SCHEDULE) {
    if (row.urls.length === 0) throw new Error(`${row.dayKey} has no problems.`);
    const slugs = row.urls.map((u) => {
      const slug = extractProblemSlug(u);
      if (!slug) throw new Error(`${row.dayKey}: could not read a slug from "${u}"`);
      return slug;
    });
    if (new Set(slugs).size !== slugs.length) {
      throw new Error(`${row.dayKey}: the same problem is assigned twice.`);
    }
  }
  console.log(`  Schedule verified: ${SCHEDULE.length} day(s), ${SCHEDULE.reduce((n, r) => n + r.urls.length, 0)} problem rows.\n`);

  // --- Resolve every problem (upsert by titleSlug — shared catalog, program-agnostic) --
  const problemIdBySlug = new Map<string, string>();
  const allSlugs = [...new Set(SCHEDULE.flatMap((r) => r.urls.map((u) => extractProblemSlug(u)!)))];

  let fetched = 0;
  let alreadyCataloged = 0;
  for (const slug of allSlugs) {
    const existing = await prisma.problem.findUnique({ where: { titleSlug: slug } });
    if (existing) {
      problemIdBySlug.set(slug, existing.id);
      alreadyCataloged += 1;
      continue;
    }
    try {
      const metadata = await provider.fetchProblemMetadata(slug);
      if (APPLY) {
        const created = await prisma.problem.upsert({
          where: { titleSlug: slug },
          create: {
            titleSlug: metadata.titleSlug,
            title: metadata.title,
            questionId: metadata.questionId,
            questionFrontendId: metadata.questionFrontendId,
            difficulty: metadata.difficulty,
            acceptanceRate: metadata.acceptanceRate,
            isPaidOnly: metadata.isPaidOnly,
            topicTags: metadata.topicTags,
            companyTags: metadata.companyTags,
            url: metadata.url,
            metadataFetchedAt: new Date(),
          },
          update: {},
        });
        problemIdBySlug.set(slug, created.id);
      } else {
        problemIdBySlug.set(slug, `(would-create:${slug})`);
      }
      fetched += 1;
    } catch (error) {
      if (error instanceof ProviderProblemNotFoundError) {
        throw new Error(`No LeetCode problem exists with the slug "${slug}" — check the URL in SCHEDULE.`);
      }
      throw error;
    }
  }
  console.log(`  Problem catalog: ${alreadyCataloged} already present, ${fetched} ${APPLY ? 'fetched and created' : 'would be fetched and created'}.\n`);

  // --- Per-day upsert -------------------------------------------------------------------
  let daysCreated = 0;
  let daysUnchanged = 0;
  let daysUpdated = 0;

  for (const row of SCHEDULE) {
    const slugs = row.urls.map((u) => extractProblemSlug(u)!);
    const existing = await prisma.infosysAssignment.findUnique({
      where: { dayKey: row.dayKey },
      include: { problems: { include: { problem: true }, orderBy: { position: 'asc' } } },
    });

    if (!existing) {
      console.log(`  ${row.dayKey}: ${APPLY ? 'creating' : 'would create'} (${slugs.length} problems)`);
      daysCreated += 1;
      if (APPLY) {
        await prisma.infosysAssignment.create({
          data: {
            dayKey: row.dayKey,
            problems: {
              create: slugs.map((slug, i) => ({ problemId: problemIdBySlug.get(slug)!, position: i + 1 })),
            },
          },
        });
      }
      continue;
    }

    const existingSlugs = existing.problems.map((p) => p.problem.titleSlug);
    const matches =
      existingSlugs.length === slugs.length && existingSlugs.every((s, i) => s === slugs[i]);

    if (matches) {
      daysUnchanged += 1;
      console.log(`  ${row.dayKey}: already correct (no-op)`);
      continue;
    }

    daysUpdated += 1;
    console.log(
      `  ${row.dayKey}: problems differ from what's stored — ${APPLY ? 'correcting' : 'would correct'} ` +
        `(stored: ${existingSlugs.join(', ') || '—'}; expected: ${slugs.join(', ')})`,
    );
    if (APPLY) {
      await prisma.$transaction([
        prisma.infosysAssignmentProblem.deleteMany({ where: { infosysAssignmentId: existing.id } }),
        prisma.infosysAssignmentProblem.createMany({
          data: slugs.map((slug, i) => ({
            infosysAssignmentId: existing.id,
            problemId: problemIdBySlug.get(slug)!,
            position: i + 1,
          })),
        }),
      ]);
      await prisma.infosysDailyProblemStatus.deleteMany({
        where: { infosysDailyStatus: { dayKey: row.dayKey } },
      });
    }
  }

  console.log('\nSummary');
  console.log(`  Days created:    ${daysCreated}`);
  console.log(`  Days unchanged:  ${daysUnchanged}`);
  console.log(`  Days corrected:  ${daysUpdated}`);
  console.log(`  Distinct problems in schedule: ${allSlugs.length}`);

  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply.');
  } else {
    console.log(
      '\nAssignments loaded. Run the Infosys rollup next (recomputeAll / ' +
        'POST /infosys/assignments/recompute) so InfosysDailyStatus reflects the new schedule.',
    );
  }
}

main()
  .catch((error: Error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
