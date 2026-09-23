/**
 * Infosys Preparation cohort reconciliation, 23 September 2026.
 *
 * The program brief was narrowed: the authoritative Infosys roster is now exactly the
 * 130 emails in the supplied sheet (7 campuses — Chitkara, JECRC, Kalasalingam, Lovely
 * Professional University, MIT-ADT, The Apollo University, Vels). The other 75 students
 * — all of RV University, Kalvium Direct, Manipal University Jaipur and Yenepoya
 * University — are no longer part of the active Infosys cohort.
 *
 * This script removes exactly those 75 `InfosysEnrollment` rows and nothing else:
 *
 *   - It never touches `Student` rows. A removed student's `Student` row, LeetCode
 *     handle, and every other field stay exactly as they are — only their Infosys
 *     *membership* is revoked.
 *   - It never touches `InfosysDailyStatus` / `InfosysDailyProblemStatus`. Those key on
 *     `studentId` directly, not on `InfosysEnrollment` (see schema.prisma), so deleting
 *     the enrollment row cannot cascade into them — the 900 historical rows the removed
 *     75 already have stay in the database, permanently, for audit. "Historical data !=
 *     active cohort": every live Infosys query (dashboard, students list, rollup) reads
 *     from `InfosysEnrollment.findMany()`, so removing the enrollment row is what drops
 *     a student out of every active view without erasing anything they already did.
 *   - It never touches `InfosysAssignment` / `InfosysAssignmentProblem`. The schedule is
 *     cohort-independent; only who is being measured against it changes.
 *   - It never touches Coding Hours. All 75 removed students are `status: 'ARCHIVED'`
 *     with `campusId: null` (verified against production before this script was
 *     written — see the run log this file's commit references) — none of them have any
 *     Coding-Hours presence to protect in the first place.
 *
 * Idempotent: a student already removed (no `InfosysEnrollment` row) is simply skipped
 * on a re-run, not an error.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-cohort-reconcile-2026-09-23.ts            # dry run
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-cohort-reconcile-2026-09-23.ts --apply     # write
 *
 * Take a backup first:
 *   pg_dump -Fc "$DATABASE_URL" > tmp/backups/pre-infosys-cohort-reconcile-<stamp>.dump
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** The authoritative Infosys roster — exactly the emails in the supplied sheet, one
 * unique campus name each. Never fuzzy-matched, never inferred: an email either
 * appears here verbatim (case-insensitive) or it does not. */
const WHITELIST_EMAILS: string[] = [
  'aman.agrawal@kalvium.community', 'chirag.sareen@kalvium.community', 'gouri.agarwal@kalvium.community',
  'abhinandan.gupta@kalvium.community', 'kamakshi.pandoh@kalvium.community', 'shubham.thakur@kalvium.community',
  'satyam.sharma@kalvium.community', 'swasti.mohanty@kalvium.community', 'diwanshu.baskota@kalvium.community',
  'ananya.tewari@kalvium.community', 'surya.p@kalvium.community', 'ansh.sharma@kalvium.community',
  'nayan.kumarraj@kalvium.community', 'rishabh.j@kalvium.community', 'dhruv.k@kalvium.community',
  'anuj.sahu@kalvium.community', 'darshan.s@kalvium.community', 'ishita.n@kalvium.community',
  'janhavi.chauhan@kalvium.community', 'kritika.w@kalvium.community', 'manvesh.t@kalvium.community',
  'manya.j@kalvium.community', 'hanshul.k@kalvium.community', 'devraj.patil@kalvium.community',
  'aniket.g@kalvium.community', 'gouransh.v@kalvium.community', 'nitin.soni@kalvium.community',
  'somuya.k@kalvium.community', 'raahul.varma@kalvium.community', 'karthika.movva@kalvium.community',
  'jatin.batchu@kalvium.community', 'mohana.gangisetti@kalvium.community', 'rishitha.n@kalvium.community',
  'sahanashre.v@kalvium.community', 'prasanna.venkatesh@kalvium.community', 'vinay.reddy@kalvium.community',
  'athithya.ramaa@kalvium.community', 'shivavarma.k@kalvium.community', 'mukilan.p@kalvium.community',
  'poshika.m@kalvium.community', 'manpreet.singh@kalvium.community', 'kprasath@kalvium.community',
  'kumar.mohan@kalvium.community', 'mukund.madhav@kalvium.community', 'mohammed.yaseen@kalvium.community',
  'harshavardhan.sr@kalvium.community', 'mohamed.fazil@kalvium.community', 'jason.william@kalvium.community',
  'nivaash.thirupathy@kalvium.community', 'aditya.raj@kalvium.community', 'vamshi.krishna@kalvium.community',
  'addarsh.kumar@kalvium.community', 'megha.wadhwa@kalvium.community', 'shivangi.jain@kalvium.community',
  'subham.mohanta@kalvium.community', 'kusumanchi.yagna@kalvium.community', 'rajashree.guha@kalvium.community',
  'vishnu.preetham@kalvium.community', 'sarvesh.perumal@kalvium.community', 'milan.sana@kalvium.community',
  'aayush.arora@kalvium.community', 'gurpreet.singh@kalvium.community', 'abdul.qureshi@kalvium.community',
  'arjun.kotha@kalvium.community', 'abhinav.rajesh@kalvium.community', 'rikhil.taneja@kalvium.community',
  'sharugeshwaran.k@kalvium.community', 'arun.kumar@kalvium.community', 'pranshu.pandey@kalvium.community',
  'jyotiranjan.sahoo@kalvium.community', 'sravan.teja@kalvium.community', 'kumar.shubham@kalvium.community',
  'arya.patil@kalvium.community', 'shreyas.wagh@kalvium.community', 'om.bankar@kalvium.community',
  'dhruv.patil@kalvium.community', 'abhinav.singh@kalvium.community', 'pranjal.gosavi@kalvium.community',
  'atharva.kharade@kalvium.community', 'bhagirath.auti@kalvium.community', 'ayush.ghodke@kalvium.community',
  'om.jadhav@kalvium.community', 'malpure.raj@kalvium.community', 'yash.bodhe@kalvium.community',
  'vaishnavi.salunkhe@kalvium.community', 'divyam.desai@kalvium.community', 'rushikesh.zope@kalvium.community',
  'kshitij.kotecha@kalvium.community', 'sahil.kharatmol@kalvium.community', 'isha.rode@kalvium.community',
  'aditya.borhade@kalvium.community', 'parth.shah@kalvium.community', 'ayush.tiwari@kalvium.community',
  'ayman.velani@kalvium.community', 'shreya.pawar@kalvium.community', 'chinmayee.harane@kalvium.community',
  'joyce.ubale@kalvium.community', 'tushar.shekhar@kalvium.community', 'bhumika.raut@kalvium.community',
  'dhruvil.sheth@kalvium.community', 'shriyans.jindal@kalvium.community', 'janhavi.hivarekar@kalvium.community',
  'harshith.a@kalvium.community', 'guna.priya@kalvium.community', 'srikeerthi.k@kalvium.community',
  'saipavithra.g@kalvium.community', 'parandhama.b@kalvium.community', 'meghana.m@kalvium.community',
  'rehman.sk@kalvium.community', 'ishana.k@kalvium.community', 'chumanilalasa.m@kalvium.community',
  'kishore.d@kalvium.community', 'ram.r@kalvium.community', 'sudhan.s@kalvium.community',
  'akhil.k@kalvium.community', 'aditya.udaykumar@kalvium.community', 'venkat.r@kalvium.community',
  'ranjan.m@kalvium.community', 'karishma.ss@kalvium.community', 'shaswath.g@kalvium.community',
  'jesudas.t@kalvium.community', 'harish.s@kalvium.community', 'jeeveeka.ps@kalvium.community',
  'manuel.b@kalvium.community', 'premapriya.d@kalvium.community', 'prasanth.j@kalvium.community',
  'mohammed.rafeeq@kalvium.community', 'jayavarsan.r@kalvium.community', 'adhithyaa.mv@kalvium.community',
  'monesh.b@kalvium.community',
].map((e) => e.toLowerCase());

const EXPECTED_TOTAL = 130;

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  const seen = new Set<string>();
  for (const email of WHITELIST_EMAILS) {
    if (seen.has(email)) throw new Error(`Duplicate email in WHITELIST_EMAILS: ${email}`);
    seen.add(email);
  }
  if (WHITELIST_EMAILS.length !== EXPECTED_TOTAL) {
    throw new Error(`WHITELIST_EMAILS has ${WHITELIST_EMAILS.length} rows, expected ${EXPECTED_TOTAL}.`);
  }

  const enrollments = await prisma.infosysEnrollment.findMany({
    select: { id: true, studentId: true, student: { select: { email: true, name: true } } },
  });

  const whitelistSet = new Set(WHITELIST_EMAILS);
  const toKeep = enrollments.filter((e) => e.student.email && whitelistSet.has(e.student.email.toLowerCase()));
  const toRemove = enrollments.filter((e) => !e.student.email || !whitelistSet.has(e.student.email.toLowerCase()));

  const dbEmailSet = new Set(
    enrollments.map((e) => e.student.email?.toLowerCase()).filter((e): e is string => !!e),
  );
  const missingFromDb = WHITELIST_EMAILS.filter((e) => !dbEmailSet.has(e));

  console.log('Summary');
  console.log(`  Current active Infosys enrollments:  ${enrollments.length}`);
  console.log(`  Whitelist size:                      ${WHITELIST_EMAILS.length}`);
  console.log(`  Keep (in whitelist):                 ${toKeep.length}`);
  console.log(`  Remove from active cohort:            ${toRemove.length}`);
  console.log(`  Whitelist emails missing from DB:    ${missingFromDb.length}`);
  console.log();

  if (missingFromDb.length > 0) {
    console.log('--- Whitelist emails with no matching student in the DB ---');
    for (const e of missingFromDb) console.log(`  ${e}`);
    console.log();
  }

  console.log('--- Students to remove from the active Infosys cohort ---');
  for (const e of toRemove) console.log(`  ${e.student.email ?? '(no email)'} — ${e.student.name}`);
  console.log();

  if (APPLY) {
    const result = await prisma.infosysEnrollment.deleteMany({
      where: { id: { in: toRemove.map((e) => e.id) } },
    });
    console.log(`Deleted ${result.count} InfosysEnrollment row(s). Student rows and all historical`);
    console.log('InfosysDailyStatus / InfosysDailyProblemStatus / InfosysAssignment rows are untouched.');
  } else {
    console.log('Nothing was written. Re-run with --apply.');
  }
}

main()
  .catch((error: Error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
