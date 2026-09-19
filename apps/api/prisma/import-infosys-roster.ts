/**
 * Import the Infosys Preparation roster (§1, §24 of the program brief).
 *
 * Run with:
 *   npm run db:import:infosys-roster -w @dsa/api -- --dry-run
 *   npm run db:import:infosys-roster -w @dsa/api --
 *
 * ## What this does and does not touch
 *
 * This creates/updates `InfosysEnrollment` rows and, only for genuinely new people,
 * `Student` rows. It never writes to any Coding-Hours-owned field on an existing
 * `Student` — not `status`, not `leetcodeUsername`, not `campusId`/`batchId`/`squadId`,
 * not any of the denormalised aggregates. A student who already exists (matched by
 * email, case-insensitive) keeps every one of those exactly as Coding Hours left them;
 * this script only ever adds an `InfosysEnrollment` row for them. See the schema
 * section banner above `InfosysEnrollment` in schema.prisma for why.
 *
 * A genuinely new `Student` is created with `leetcodeUsername: null` — never invented,
 * never guessed, never derived from the email — and `syncState.status:
 * 'PROFILE_MISSING'`, the same status `import-campus-roster.ts` uses for a roster row
 * with no handle. `name` has no source in the brief (only email + campus were given),
 * so it is derived from the email's local part purely as a display placeholder (e.g.
 * `aman.agrawal@...` → "Aman Agrawal") — cosmetic only, never treated as verified
 * identity data, and safe to correct later without affecting any matching logic (which
 * is keyed on email throughout).
 *
 * `status: 'ARCHIVED'`, not `'ACTIVE'` — found live, the hard way: every Coding-Hours
 * "current roster" surface (dashboard, leaderboard, campus-analysis, reports,
 * analytics) filters on `Student.status: 'ACTIVE'` with no other discriminator, an
 * invariant that held until this import created the first-ever `status: 'ACTIVE'`,
 * `campusId: null` students in the system's history. `ACTIVE` silently inflated every
 * one of those Coding-Hours aggregates with students who have no Coding-Hours
 * campus, batch, or assignment at all. `ARCHIVED` is the status this codebase already
 * excludes from every one of those views, comprehensively and consistently — reusing
 * it closes the leak everywhere at once. It has no effect on Infosys: neither
 * `InfosysRollupService` nor the sync-eligibility query in `sync.service.ts` reads
 * `Student.status` (sync eligibility already includes any student with an
 * `InfosysEnrollment` regardless of status).
 *
 * ## Campus resolution
 *
 * A campus is one real institution, not a per-program label (see the schema banner).
 * "Vels Institute of Science" in this roster is the same institution as the existing
 * Coding Hours campus "Vels Institute of Science, Technology & Advanced Studies" —
 * confirmed against production, where 12 of these 19 emails already exist as archived
 * Coding Hours students at that exact campus id. That alias is hardcoded below rather
 * than fuzzy-matched, because a generic substring/fuzzy match on campus names risks
 * silently merging two institutions that happen to share a prefix; every other campus
 * name in this roster gets its own new `Campus` row.
 *
 * ## Idempotent
 *
 * Re-running reports every already-imported student and campus as unchanged and
 * writes nothing further, exactly like `import-campus-roster.ts`.
 */

import { PrismaClient } from '@prisma/client';

import {
  EXPECTED_CAMPUS_COUNTS,
  EXPECTED_TOTAL,
  INFOSYS_ROSTER,
  SUGGESTED_CAMPUS_CODE,
} from './infosys-roster-data';

const prisma = new PrismaClient();

/** Infosys roster campus name -> existing Coding-Hours `Campus.code`, confirmed by a
 * live production check, not guessed. See the file banner. */
const CAMPUS_ALIASES: Record<string, string> = {
  'Vels Institute of Science': 'VELS',
};

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function resolveCampuses(
  dryRun: boolean,
): Promise<{ map: Map<string, string>; created: string[]; reused: string[] }> {
  const map = new Map<string, string>();
  const created: string[] = [];
  const reused: string[] = [];

  for (const campusName of Object.keys(EXPECTED_CAMPUS_COUNTS)) {
    const aliasCode = CAMPUS_ALIASES[campusName];
    if (aliasCode) {
      const existing = await prisma.campus.findUnique({ where: { code: aliasCode } });
      if (!existing) {
        throw new Error(
          `Campus alias "${campusName}" -> code "${aliasCode}" does not exist. ` +
            'This alias was confirmed against a real database at design time; if it is ' +
            'genuinely gone, remove the alias so a new campus is created instead.',
        );
      }
      map.set(campusName, existing.id);
      reused.push(`${campusName} -> existing "${existing.name}" (${existing.code})`);
      continue;
    }

    const existingByName = await prisma.campus.findUnique({ where: { name: campusName } });
    if (existingByName) {
      map.set(campusName, existingByName.id);
      reused.push(`${campusName} -> existing "${existingByName.name}" (${existingByName.code})`);
      continue;
    }

    const code = SUGGESTED_CAMPUS_CODE[campusName];
    if (!code) throw new Error(`No suggested code for new campus "${campusName}".`);

    const codeTaken = await prisma.campus.findUnique({ where: { code } });
    if (codeTaken) {
      throw new Error(
        `Campus code "${code}" (suggested for "${campusName}") is already used by ` +
          `"${codeTaken.name}". Resolve this collision in infosys-roster-data.ts before importing.`,
      );
    }

    if (dryRun) {
      // Dry run cannot create the row to get a real id, but still needs to report
      // per-student campus resolution correctly — a synthetic placeholder id is fine
      // because it is never written.
      map.set(campusName, `(would-create:${code})`);
      created.push(`${campusName} (new campus, code ${code})`);
      continue;
    }

    const newCampus = await prisma.campus.create({
      data: { name: campusName, code, status: 'ACTIVE' },
    });
    map.set(campusName, newCampus.id);
    created.push(`${campusName} -> created "${newCampus.name}" (${newCampus.code})`);
  }

  return { map, created, reused };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\nInfosys Preparation roster import${dryRun ? ' (DRY RUN — nothing will be written)' : ''}\n`);

  // --- Data integrity, before touching the database ------------------------
  if (INFOSYS_ROSTER.length !== EXPECTED_TOTAL) {
    throw new Error(
      `INFOSYS_ROSTER has ${INFOSYS_ROSTER.length} rows, expected ${EXPECTED_TOTAL}. ` +
        'Refusing to import until infosys-roster-data.ts matches the source roster.',
    );
  }
  const counts = new Map<string, number>();
  for (const row of INFOSYS_ROSTER) counts.set(row.campusName, (counts.get(row.campusName) ?? 0) + 1);
  for (const [campus, expected] of Object.entries(EXPECTED_CAMPUS_COUNTS)) {
    const actual = counts.get(campus) ?? 0;
    if (actual !== expected) {
      throw new Error(`Campus "${campus}" has ${actual} roster rows, expected ${expected}.`);
    }
  }
  const emailSet = new Set(INFOSYS_ROSTER.map((r) => r.email));
  if (emailSet.size !== INFOSYS_ROSTER.length) {
    throw new Error('Duplicate emails found in INFOSYS_ROSTER — refusing to import.');
  }
  console.log(`  Roster data verified: ${INFOSYS_ROSTER.length} rows across ${counts.size} campuses.\n`);

  // --- Campus resolution -----------------------------------------------------
  const { map: campusIdByName, created: createdCampuses, reused: reusedCampuses } =
    await resolveCampuses(dryRun);

  console.log('  Campuses');
  for (const line of reusedCampuses) console.log(`    reused:  ${line}`);
  for (const line of createdCampuses) console.log(`    ${dryRun ? 'would create' : 'created'}: ${line}`);
  console.log();

  // --- Reconciliation, before a single student write --------------------------
  const emails = INFOSYS_ROSTER.map((r) => r.email);
  const existing = await prisma.student.findMany({
    where: { email: { in: emails, mode: 'insensitive' } },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      leetcodeUsername: true,
      infosysEnrollment: { select: { id: true, campusId: true } },
    },
  });
  const existingByEmail = new Map(existing.map((s) => [s.email!.toLowerCase(), s]));

  let newStudents = 0;
  let matchedExistingStudents = 0;
  let matchedWithLeetcodeAlready = 0;
  let enrollmentsToCreate = 0;
  let enrollmentsAlreadyCorrect = 0;
  let enrollmentsToUpdateCampus = 0;

  for (const row of INFOSYS_ROSTER) {
    const match = existingByEmail.get(row.email);
    const targetCampusId = campusIdByName.get(row.campusName);
    if (!match) {
      newStudents += 1;
      enrollmentsToCreate += 1;
      continue;
    }
    matchedExistingStudents += 1;
    if (match.leetcodeUsername) matchedWithLeetcodeAlready += 1;
    if (!match.infosysEnrollment) {
      enrollmentsToCreate += 1;
    } else if (match.infosysEnrollment.campusId !== targetCampusId) {
      enrollmentsToUpdateCampus += 1;
    } else {
      enrollmentsAlreadyCorrect += 1;
    }
  }

  const line = (label: string, value: number | string): void =>
    console.log(`    ${label.padEnd(42)} ${value}`);

  console.log('  Reconciliation');
  line('Roster rows:', INFOSYS_ROSTER.length);
  line('New students to create:', newStudents);
  line('Matched existing students (untouched):', matchedExistingStudents);
  line('  ...of which already have a LeetCode handle:', matchedWithLeetcodeAlready);
  line('Enrollments to create:', enrollmentsToCreate);
  line('Enrollments to correct (campus changed):', enrollmentsToUpdateCampus);
  line('Enrollments already correct (no-op):', enrollmentsAlreadyCorrect);
  console.log();

  if (dryRun) {
    console.log('Dry run complete — nothing was written.');
    return;
  }

  // --- Import -----------------------------------------------------------------
  let createdStudents = 0;
  let createdEnrollments = 0;
  let updatedEnrollments = 0;
  let unchangedEnrollments = 0;
  const failures: string[] = [];

  for (const row of INFOSYS_ROSTER) {
    const targetCampusId = campusIdByName.get(row.campusName);
    if (!targetCampusId) throw new Error(`No resolved campus id for "${row.campusName}"`);

    try {
      const match = existingByEmail.get(row.email);
      let studentId: string;

      if (match) {
        studentId = match.id;
      } else {
        // ARCHIVED, not ACTIVE — a student who has never been part of Coding Hours
        // must not count as one. `Student.status: 'ACTIVE'` is the base population
        // filter for every Coding-Hours "current roster" surface (dashboard,
        // leaderboard, campus-analysis, reports, analytics — verified, all of them),
        // and a genuinely new Infosys-only student has `campusId: null` besides,
        // which those queries never expected either. ARCHIVED is the one status this
        // codebase already, comprehensively treats as excluded from every current
        // Coding-Hours view, so reusing it here closes the leak everywhere at once
        // instead of patching each of those files individually. It does not affect
        // Infosys at all: InfosysRollupService and the widened sync-eligibility query
        // (sync.service.ts) never read Student.status — sync eligibility already
        // includes any student with an InfosysEnrollment regardless of status.
        const created = await prisma.student.create({
          data: {
            name: displayNameFromEmail(row.email),
            email: row.email,
            leetcodeUsername: null,
            status: 'ARCHIVED',
            archivedAt: new Date(),
            archivedReason: 'Never enrolled in Coding Hours — Infosys Preparation only',
            syncState: { create: { status: 'PROFILE_MISSING' } },
          },
          select: { id: true },
        });
        studentId = created.id;
        createdStudents += 1;
      }

      const enrollment = await prisma.infosysEnrollment.findUnique({ where: { studentId } });
      if (!enrollment) {
        await prisma.infosysEnrollment.create({
          data: { studentId, campusId: targetCampusId },
        });
        createdEnrollments += 1;
      } else if (enrollment.campusId !== targetCampusId) {
        await prisma.infosysEnrollment.update({
          where: { studentId },
          data: { campusId: targetCampusId },
        });
        updatedEnrollments += 1;
      } else {
        unchangedEnrollments += 1;
      }
    } catch (error) {
      failures.push(`${row.email}: ${(error as Error).message}`);
    }
  }

  console.log('  Import');
  console.log(`    Students created:       ${createdStudents}`);
  console.log(`    Enrollments created:     ${createdEnrollments}`);
  console.log(`    Enrollments updated:     ${updatedEnrollments}`);
  console.log(`    Enrollments unchanged:   ${unchangedEnrollments}`);
  if (failures.length > 0) {
    console.log(`    Failed:                  ${failures.length}`);
    for (const failure of failures) console.log(`      ${failure}`);
  }

  const totalEnrolled = await prisma.infosysEnrollment.count();
  console.log(`\n  Infosys Preparation now has ${totalEnrolled} enrolled student(s).`);
  console.log('\nImport complete. Add InfosysAssignment rows, then run the Infosys rollup.');

  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('\nInfosys roster import failed:', (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
