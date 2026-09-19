/**
 * Repair the `Student.status` of Infosys-only students created before this codebase
 * knew better.
 *
 * ## What went wrong
 *
 * `import-infosys-roster.ts` originally created new Infosys students with
 * `status: 'ACTIVE'`. Every Coding-Hours "current roster" surface — dashboard,
 * leaderboard, campus-analysis, reports, analytics — filters its base population on
 * `Student.status: 'ACTIVE'` alone, an invariant that held until this import created
 * the first-ever `status: 'ACTIVE'`, `campusId: null` students in the system's
 * history. The result: 193 students with no Coding-Hours campus, batch or assignment
 * silently inflated every one of those Coding-Hours aggregates (student counts,
 * "profile missing" tallies, the campus filter picker, everything downstream).
 *
 * The import script is fixed to create `status: 'ARCHIVED'` from now on. This script
 * repairs the rows already written.
 *
 * ## What it does
 *
 * For every `Student` with `status: 'ACTIVE'`, `campusId: null`, and an
 * `InfosysEnrollment` — the exact, narrow shape only this import ever produces —
 * sets `status: 'ARCHIVED'`, `archivedAt`, `archivedReason`. Nothing else is touched:
 * no other field, no other student. A genuine Coding-Hours student always has
 * `campusId` set (the roster importer backfills it and every write path sets it — see
 * the `Student.campusId` comment in schema.prisma), so this predicate cannot match one.
 *
 * Idempotent: a second run finds nothing, because the repaired rows are no longer
 * `status: 'ACTIVE'`.
 *
 *   npm run db:backfill:infosys-status -w @dsa/api            # report only
 *   npm run db:backfill:infosys-status -w @dsa/api -- --apply # write
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const affected = await prisma.student.findMany({
    where: { status: 'ACTIVE', campusId: null, infosysEnrollment: { isNot: null } },
    select: { id: true, name: true, email: true },
  });

  console.log(`\nInfosys student status backfill${apply ? '' : ' (report only — pass --apply to write)'}\n`);
  console.log(`  Found ${affected.length} student(s) with status: ACTIVE, campusId: null, Infosys-enrolled.`);

  if (affected.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  if (!apply) {
    for (const student of affected.slice(0, 10)) {
      console.log(`    ${student.email ?? '(no email)'} — ${student.name}`);
    }
    if (affected.length > 10) console.log(`    ... and ${affected.length - 10} more`);
    console.log('\n  Report only — pass --apply to write.');
    return;
  }

  const result = await prisma.student.updateMany({
    where: { id: { in: affected.map((s) => s.id) } },
    data: {
      status: 'ARCHIVED',
      archivedAt: new Date(),
      archivedReason: 'Never enrolled in Coding Hours — Infosys Preparation only',
    },
  });

  console.log(`  Updated ${result.count} student(s) to status: ARCHIVED.`);
}

main()
  .catch((error) => {
    console.error('\nBackfill failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
