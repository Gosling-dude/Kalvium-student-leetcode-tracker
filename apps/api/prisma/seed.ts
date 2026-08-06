/**
 * Database seed.
 *
 * Creates the admin account, the default scoring formula, and — outside production —
 * a realistic demo cohort so the dashboard, leaderboards and reports have something to
 * show before the first real sync.
 *
 * Idempotent: safe to run repeatedly.
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import {
  DEFAULT_SCORING_CONFIG,
  addDays,
  computeDailyScore,
  computeStreaks,
  leetcodeProblemUrl,
  toDayKey,
  type StreakDay,
} from '@dsa/shared';

const prisma = new PrismaClient();

const TIMEZONE = process.env.PROGRAM_TIMEZONE ?? 'Asia/Kolkata';
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@kalvium.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME ?? 'Program Admin';
const SEED_DEMO = process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO !== 'false';

/**
 * The demo cohort lives in its own batch, kept apart from the real roster loaded by
 * `seed-students.ts` (`Batch 2026` by default). Everything below is scoped to it, so
 * running this seed on a database that already holds real students cannot touch them.
 */
const DEMO_BATCH_NAME = 'Demo Batch';

/** Real LeetCode problems, so slugs and difficulties are genuine. */
const PROBLEM_POOL: { slug: string; title: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD'; tags: string[] }[] = [
  { slug: 'two-sum', title: 'Two Sum', difficulty: 'EASY', tags: ['Array', 'Hash Table'] },
  { slug: 'valid-parentheses', title: 'Valid Parentheses', difficulty: 'EASY', tags: ['Stack', 'String'] },
  { slug: 'merge-intervals', title: 'Merge Intervals', difficulty: 'MEDIUM', tags: ['Array', 'Sorting'] },
  { slug: 'lru-cache', title: 'LRU Cache', difficulty: 'MEDIUM', tags: ['Hash Table', 'Design'] },
  { slug: 'longest-substring-without-repeating-characters', title: 'Longest Substring Without Repeating Characters', difficulty: 'MEDIUM', tags: ['Hash Table', 'Sliding Window'] },
  { slug: 'trapping-rain-water', title: 'Trapping Rain Water', difficulty: 'HARD', tags: ['Array', 'Two Pointers'] },
  { slug: 'course-schedule', title: 'Course Schedule', difficulty: 'MEDIUM', tags: ['Graph', 'Topological Sort'] },
  { slug: 'word-ladder', title: 'Word Ladder', difficulty: 'HARD', tags: ['BFS', 'Hash Table'] },
  { slug: 'binary-tree-level-order-traversal', title: 'Binary Tree Level Order Traversal', difficulty: 'MEDIUM', tags: ['Tree', 'BFS'] },
  { slug: 'coin-change', title: 'Coin Change', difficulty: 'MEDIUM', tags: ['Dynamic Programming'] },
  { slug: 'number-of-islands', title: 'Number of Islands', difficulty: 'MEDIUM', tags: ['Graph', 'DFS'] },
  { slug: 'median-of-two-sorted-arrays', title: 'Median of Two Sorted Arrays', difficulty: 'HARD', tags: ['Array', 'Binary Search'] },
];

const FIRST_NAMES = ['Asha', 'Bilal', 'Chen', 'Divya', 'Ethan', 'Farah', 'Gaurav', 'Hina', 'Ishan', 'Jaya', 'Karan', 'Leena', 'Manav', 'Nisha', 'Omar', 'Priya', 'Rahul', 'Sara', 'Tarun', 'Uma', 'Varun', 'Wafa', 'Yash', 'Zara'];
const LAST_NAMES = ['Menon', 'Khan', 'Wei', 'Sharma', 'Rodriguez', 'Ahmed', 'Patel', 'Sheikh', 'Verma', 'Nair', 'Singh', 'Joseph', 'Desai', 'Rao', 'Ali', 'Iyer', 'Gupta', 'Fernandes', 'Kapoor', 'Bose'];

/** Deterministic PRNG so re-seeding produces the same demo data. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function main(): Promise<void> {
  console.log('Seeding DSA Tracker…');

  // --- Admin ---------------------------------------------------------------
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL.toLowerCase() },
    create: {
      email: ADMIN_EMAIL.toLowerCase(),
      name: ADMIN_NAME,
      passwordHash,
      role: 'ADMIN',
    },
    // Never silently reset an existing admin's password on a re-seed.
    update: { name: ADMIN_NAME },
  });
  console.log(`  admin: ${admin.email}`);

  // --- Scoring formula -----------------------------------------------------
  const activeConfig = await prisma.scoringConfig.findFirst({ where: { isActive: true } });
  if (!activeConfig) {
    await prisma.scoringConfig.create({
      data: {
        name: 'Default formula',
        isActive: true,
        config: DEFAULT_SCORING_CONFIG as unknown as Prisma.InputJsonValue,
        createdById: admin.id,
      },
    });
    console.log('  scoring formula: default created');
  }

  // --- Problems ------------------------------------------------------------
  for (const problem of PROBLEM_POOL) {
    await prisma.problem.upsert({
      where: { titleSlug: problem.slug },
      create: {
        titleSlug: problem.slug,
        title: problem.title,
        difficulty: problem.difficulty,
        topicTags: problem.tags,
        url: leetcodeProblemUrl(problem.slug),
        acceptanceRate: 45 + Math.round(Math.random() * 30),
      },
      update: {},
    });
  }

  if (!SEED_DEMO) {
    console.log('Seed complete (demo data skipped).');
    return;
  }

  // --- Demo cohort ---------------------------------------------------------
  const random = makeRandom(20260804);
  const today = toDayKey(new Date(), TIMEZONE);

  const mentorPassword = await bcrypt.hash('Mentor!2026', 12);
  const mentors = await Promise.all(
    ['Ravi Kulkarni', 'Sneha Pillai', 'Arjun Mehta'].map((name, index) =>
      prisma.user.upsert({
        where: { email: `mentor${index + 1}@kalvium.com` },
        create: {
          email: `mentor${index + 1}@kalvium.com`,
          name,
          passwordHash: mentorPassword,
          role: 'MENTOR',
        },
        update: {},
      }),
    ),
  );

  // A batch of its own, deliberately not the roster's `Batch 2026`. Sharing one would
  // let this seed synthesise 30 days of fabricated history onto real students — data
  // indistinguishable from a genuine sync in every report and leaderboard.
  const batch = await prisma.batch.upsert({
    where: { name: DEMO_BATCH_NAME },
    create: { name: DEMO_BATCH_NAME, startDate: new Date('2026-06-01'), isActive: true },
    update: {},
  });

  const squadColors = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7'];
  const squads = [];
  for (let i = 0; i < 6; i += 1) {
    const name = `Squad ${i + 1}`;
    const existing = await prisma.squad.findFirst({ where: { name, batchId: batch.id } });
    squads.push(
      existing ??
        (await prisma.squad.create({
          data: {
            name,
            batchId: batch.id,
            mentorId: mentors[i % mentors.length]!.id,
            color: squadColors[i],
          },
        })),
    );
  }

  // Scoped to the demo batch, not to every student. A dev database may also hold the
  // real roster (`prisma/seed-students.ts`), and those students must never be counted
  // here — nor given the synthetic history synthesised further down.
  const existingStudents = await prisma.student.count({ where: { batchId: batch.id } });
  const STUDENT_COUNT = 60;

  if (existingStudents === 0) {
    for (let i = 0; i < STUDENT_COUNT; i += 1) {
      const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
      const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]!;
      const name = `${first} ${last}`;
      const handle = `${first}.${last}${i}`.toLowerCase().replace(/\./g, '_');

      await prisma.student.create({
        data: {
          name,
          email: `${handle}@kalvium.com`,
          leetcodeUsername: handle,
          batchId: batch.id,
          squadId: squads[i % squads.length]!.id,
          phone: `98${String(10000000 + i).slice(0, 8)}`,
          // Demo students are marked as never synced, because they are not real
          // LeetCode accounts. Their history below is synthetic and labelled as such.
          syncState: { create: { status: 'NEVER_SYNCED' } },
        },
      });
    }
    console.log(`  students: ${STUDENT_COUNT} created`);
  }

  const students = await prisma.student.findMany({
    where: { batchId: batch.id },
    select: { id: true },
  });

  // --- 30 days of assignments and synthetic outcomes -----------------------
  const DAYS = 30;
  const problems = await prisma.problem.findMany();

  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const dayKey = addDays(today, -offset);

    let assignment = await prisma.assignment.findUnique({ where: { dayKey } });
    if (!assignment) {
      const picked = [...problems].sort(() => random() - 0.5).slice(0, 4);
      assignment = await prisma.assignment.create({
        data: {
          dayKey,
          topic: picked[0]?.topicTags[0] ?? 'Mixed',
          title: `Day ${DAYS - offset}`,
          createdById: admin.id,
          problems: {
            create: picked.map((problem, index) => ({
              problemId: problem.id,
              position: index + 1,
            })),
          },
        },
      });
    }
  }

  // Synthesise daily statuses with per-student ability, so leaderboards and streaks
  // have a realistic spread rather than uniform noise.
  const abilities = new Map(students.map((s) => [s.id, 0.25 + random() * 0.7]));
  const historyByStudent = new Map<string, StreakDay[]>();

  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const dayKey = addDays(today, -offset);
    const assignment = await prisma.assignment.findUnique({
      where: { dayKey },
      include: { problems: { include: { problem: true } } },
    });
    if (!assignment) continue;

    const assignedCount = assignment.problems.length;

    for (const student of students) {
      const ability = abilities.get(student.id)!;
      const roll = random();
      const solvedCount =
        roll < ability * 0.75
          ? assignedCount
          : roll < ability + 0.15
            ? Math.max(0, assignedCount - 1 - Math.floor(random() * 2))
            : Math.floor(random() * 2);

      const history = historyByStudent.get(student.id) ?? [];
      history.push({ dayKey, solvedCount, assignedCount });
      historyByStudent.set(student.id, history);

      const streaks = computeStreaks(history, dayKey, DEFAULT_SCORING_CONFIG);

      const completionMinute =
        solvedCount >= assignedCount ? 7 * 60 + Math.floor(random() * 14 * 60) : null;

      const solvedDifficulties = assignment.problems
        .slice(0, solvedCount)
        .map((p) => p.problem.difficulty);

      const score = computeDailyScore(
        {
          solvedCount,
          assignedCount,
          completionMinuteOfDay: completionMinute,
          solvedDifficulties,
          streakLength: streaks.current,
        },
        DEFAULT_SCORING_CONFIG,
      );

      const completedAt =
        completionMinute !== null
          ? new Date(`${dayKey}T00:00:00Z`).getTime() + completionMinute * 60_000
          : null;

      await prisma.dailyStatus.upsert({
        where: { studentId_dayKey: { studentId: student.id, dayKey } },
        create: {
          studentId: student.id,
          dayKey,
          assignmentId: assignment.id,
          assignedCount,
          solvedCount,
          score: score.total,
          scoreBreakdown: score.components as unknown as Prisma.InputJsonValue,
          completedAt: completedAt ? new Date(completedAt) : null,
          completionMinute,
          isPerfect: solvedCount >= assignedCount,
          streakAtDay: streaks.current,
          syncStatus: 'OK',
        },
        update: {},
      });
    }
  }

  // Refresh cached aggregates so the UI is consistent immediately after seeding.
  for (const student of students) {
    const history = historyByStudent.get(student.id) ?? [];
    const streaks = computeStreaks(history, today, DEFAULT_SCORING_CONFIG);
    const totals = await prisma.dailyStatus.aggregate({
      where: { studentId: student.id },
      _sum: { score: true, solvedCount: true },
    });

    await prisma.student.update({
      where: { id: student.id },
      data: {
        currentStreak: streaks.current,
        longestStreak: streaks.longest,
        totalScore: totals._sum.score ?? 0,
        totalSolved: totals._sum.solvedCount ?? 0,
        mediumSolved: Math.round((totals._sum.solvedCount ?? 0) * 0.6),
        easySolved: Math.round((totals._sum.solvedCount ?? 0) * 0.3),
        hardSolved: Math.round((totals._sum.solvedCount ?? 0) * 0.1),
      },
    });
  }

  console.log(`  demo history: ${DAYS} days across ${students.length} students`);
  console.log('\nSeed complete.');
  console.log(`  Sign in as ${ADMIN_EMAIL}`);
  console.log('  Run a leaderboard rebuild from the admin panel, or POST /admin/recompute.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
