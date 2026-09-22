/**
 * Infosys Preparation profile update, 22 September 2026.
 *
 * The program brief supplied a fresh campus + LeetCode-link table for 130 of the 205
 * already-enrolled Infosys students (the other 75 — Kalvium Direct, Manipal Jaipur, RV
 * University, Yenepoya — are untouched by this table). This script updates two things,
 * both by email, never by name or by guessing:
 *
 *   1. `InfosysEnrollment.campusId` — only if it actually differs from what is stored.
 *   2. `Student.leetcodeUsername` — only for a handle that resolves on a live LeetCode
 *      check, following [[roster-urls-go-stale-verify-live]]: query the live API for
 *      every candidate handle, and where the roster and the database disagree, keep
 *      whichever one actually resolves; never invent a handle from a name or email.
 *
 * `Student.leetcodeUsername` is normally a Coding-Hours-owned field — see the header
 * comment on `import-infosys-roster.ts` — which this script would normally leave alone.
 * It is safe to touch here because every one of these 130 students was checked against
 * production first: all 130 are `status: 'ARCHIVED'` with no Coding-Hours campus
 * (Infosys-only), so nothing here can touch a live Coding-Hours record. If that
 * assumption ever stops holding for a future run of this file, the script refuses
 * rather than silently writing over a Coding-Hours-owned handle (see `assertInfosysOnly`).
 *
 * Run with:
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-profile-update-2026-09-22.ts            # dry run
 *   DATABASE_URL=... npx tsx apps/api/scripts/infosys-profile-update-2026-09-22.ts --apply     # write
 *
 * Take a backup first:
 *   pg_dump -Fc "$DATABASE_URL" > tmp/backups/pre-infosys-profile-update-<stamp>.dump
 */

import { PrismaClient } from '@prisma/client';
import { resolveLeetcodeProfile } from '@dsa/shared';

import { loadConfiguration } from '../src/config/configuration';
import { LeetCodeProvider } from '../src/modules/providers/leetcode/leetcode.provider';
import { isProviderError } from '../src/modules/providers/provider.errors';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

interface Row {
  email: string;
  campusName: string;
  /** Verbatim from the brief. "NO PROFILE" is a deliberate marker, not a URL. */
  raw: string;
}

/** Same alias this program's roster import uses — see `import-infosys-roster.ts`. */
const CAMPUS_ALIASES: Record<string, string> = {
  'Vels Institute of Science': 'VELS',
};

const ROWS: Row[] = [
  ['aman.agrawal@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/hiamanagrawal/'],
  ['chirag.sareen@kalvium.community', 'Chitkara University', 'https://www.leetcode.com/chirag_sareen'],
  ['gouri.agarwal@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/Gouri_Agarwal/'],
  ['abhinandan.gupta@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/Abhinandan-0205'],
  ['kamakshi.pandoh@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/kamakship18/'],
  ['shubham.thakur@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/Shubhh_Thakur/'],
  ['satyam.sharma@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/satyamsharma36/'],
  ['swasti.mohanty@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/Swasti008/'],
  ['diwanshu.baskota@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/Diwansu/'],
  ['ananya.tewari@kalvium.community', 'Chitkara University', 'https://leetcode.com/u/ananyatewari0205/'],

  ['surya.p@kalvium.community', 'JECRC University', 'https://leetcode.com/u/H1IxqQzdIz/'],
  ['ansh.sharma@kalvium.community', 'JECRC University', 'https://leetcode.com/u/anshs052004/'],
  ['nayan.kumarraj@kalvium.community', 'JECRC University', 'https://leetcode.com/u/Nayan_Kumar_Raj/'],
  ['rishabh.j@kalvium.community', 'JECRC University', 'https://leetcode.com/u/vCWJGBpvKF/'],
  ['dhruv.k@kalvium.community', 'JECRC University', 'https://leetcode.com/u/Dhruv1184/'],
  ['anuj.sahu@kalvium.community', 'JECRC University', 'https://leetcode.com/u/officialanuj004/'],
  ['darshan.s@kalvium.community', 'JECRC University', 'https://leetcode.com/u/DarshanS-Singh/'],
  ['ishita.n@kalvium.community', 'JECRC University', 'https://leetcode.com/u/ishita_naraniya/'],
  ['janhavi.chauhan@kalvium.community', 'JECRC University', 'https://leetcode.com/u/Janhavi-Chauhan/'],
  ['kritika.w@kalvium.community', 'JECRC University', 'https://leetcode.com/u/kritikawalia10/'],
  ['manvesh.t@kalvium.community', 'JECRC University', 'https://leetcode.com/u/manvesh0201/'],
  ['manya.j@kalvium.community', 'JECRC University', 'https://leetcode.com/u/manyajain252/'],
  ['hanshul.k@kalvium.community', 'JECRC University', 'https://leetcode.com/u/hanshulkumawat22/'],
  ['devraj.patil@kalvium.community', 'JECRC University', 'https://leetcode.com/u/5whanVUHuz/'],
  ['aniket.g@kalvium.community', 'JECRC University', 'https://leetcode.com/u/AniketG51'],
  ['gouransh.v@kalvium.community', 'JECRC University', 'https://leetcode.com/u/Gouransh29/'],
  ['nitin.soni@kalvium.community', 'JECRC University', 'https://leetcode.com/u/nitin-soni/'],
  ['somuya.k@kalvium.community', 'JECRC University', 'https://leetcode.com/u/somuyakhandelwal/'],

  ['raahul.varma@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/Rahulvarma21/'],
  ['karthika.movva@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/KarthikaMovva/'],
  ['jatin.batchu@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/JatinJayadev'],
  ['mohana.gangisetti@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/user6482Uq/'],
  ['rishitha.n@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/Fzc6umf3yu/'],
  ['sahanashre.v@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/sahanashre-v'],
  ['prasanna.venkatesh@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/SPrasannaVenketesh/'],
  ['vinay.reddy@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/vinnugollakoti1/'],
  ['athithya.ramaa@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/v-athithyaramaa/'],
  ['shivavarma.k@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/ShivaVarma_k/'],
  ['mukilan.p@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/user6528vJ/'],
  ['poshika.m@kalvium.community', 'Kalasalingam Academy of Research and Education', 'https://leetcode.com/u/poshika_09/'],

  ['manpreet.singh@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/manpreetsingh04/'],
  ['kprasath@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/krishnaprasath741/'],
  ['kumar.mohan@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/QEjYuEwpVR/'],
  ['mukund.madhav@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/mukundmadhav054/'],
  ['mohammed.yaseen@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/user3544WV/'],
  ['harshavardhan.sr@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/harshavardhan2023/'],
  ['mohamed.fazil@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/yPQl9jnTgP/'],
  ['jason.william@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['nivaash.thirupathy@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/0IiitH7Byk/'],
  ['aditya.raj@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['vamshi.krishna@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/vamshineela06/'],
  ['addarsh.kumar@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/Addarsh_Kumar/'],
  ['megha.wadhwa@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/meghawadhwa20'],
  ['shivangi.jain@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['subham.mohanta@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/subham789/'],
  ['kusumanchi.yagna@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/K_Yagna/'],
  ['rajashree.guha@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['vishnu.preetham@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/VishnuPreetham/'],
  ['sarvesh.perumal@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['milan.sana@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['aayush.arora@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['gurpreet.singh@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['abdul.qureshi@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['arjun.kotha@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['abhinav.rajesh@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/e9pAc6LLoL/'],
  ['rikhil.taneja@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/rikhiltaneja/'],
  ['sharugeshwaran.k@kalvium.community', 'Lovely Professional University', 'https://share.google/xOfZwvs661LWAkRiI'],
  ['arun.kumar@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/vQPBhL4go7/'],
  ['pranshu.pandey@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['jyotiranjan.sahoo@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['sravan.teja@kalvium.community', 'Lovely Professional University', 'NO PROFILE'],
  ['kumar.shubham@kalvium.community', 'Lovely Professional University', 'https://leetcode.com/u/shubham081908'],

  ['arya.patil@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/aryapatil07/'],
  ['shreyas.wagh@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Shreyas2004wagh/'],
  ['om.bankar@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/dhruvinspace/'],
  ['dhruv.patil@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/dhruvinspace/'],
  ['abhinav.singh@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/abhinav0603/'],
  ['pranjal.gosavi@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/pranjal-2507/'],
  ['atharva.kharade@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Atharva279'],
  ['bhagirath.auti@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/bhagirathauti/'],
  ['ayush.ghodke@kalvium.community', 'MIT-ADT University', 'NO PROFILE'],
  ['om.jadhav@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/o1HHtEg3RI/'],
  ['malpure.raj@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/raj_malpure'],
  ['yash.bodhe@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/edvzNMXi04/'],
  ['vaishnavi.salunkhe@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/VaishnaviSalunkhe18/'],
  ['divyam.desai@kalvium.community', 'MIT-ADT University', 'NO PROFILE'],
  ['rushikesh.zope@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/rushikeshz/'],
  ['kshitij.kotecha@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/kshitij_162005/'],
  ['sahil.kharatmol@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/sahil_k17/'],
  ['isha.rode@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/IshaRode/'],
  ['aditya.borhade@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/user0497QO/'],
  ['parth.shah@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/parthsss/'],
  ['ayush.tiwari@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/AyushTiwari27/'],
  ['ayman.velani@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/secondayman/'],
  ['shreya.pawar@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/YrnHIIbTCw/'],
  ['chinmayee.harane@kalvium.community', 'MIT-ADT University', 'NO PROFILE'],
  ['joyce.ubale@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Joyce-ubale29/'],
  ['tushar.shekhar@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Tusharshekhar123/'],
  ['bhumika.raut@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Bhumika111/'],
  ['dhruvil.sheth@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/dhruvildeepaksheth/'],
  ['shriyans.jindal@kalvium.community', 'MIT-ADT University', 'NO PROFILE'],
  ['janhavi.hivarekar@kalvium.community', 'MIT-ADT University', 'https://leetcode.com/u/Janhavi_2103/'],

  ['harshith.a@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/DinoDDG/'],
  ['guna.priya@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/GunapriyaReddy/'],
  ['srikeerthi.k@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/srikeerthireddy/'],
  ['saipavithra.g@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/pezT6UJg8J/'],
  ['parandhama.b@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/PARANDHAMA_REDDY/'],
  ['meghana.m@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/meghanamanchal/'],
  ['rehman.sk@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/Habeeb_26k/'],
  ['ishana.k@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/gcLkkro9vd/'],
  ['chumanilalasa.m@kalvium.community', 'The Apollo University', 'https://leetcode.com/u/chumani_lalasa17/'],

  ['kishore.d@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/ghostWolf/'],
  ['ram.r@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/dizzymentor22/'],
  ['sudhan.s@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/sudhanssudhan83/'],
  ['akhil.k@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/akhilk49/'],
  ['aditya.udaykumar@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/adityakannur28/'],
  ['venkat.r@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/samvenkat/'],
  ['ranjan.m@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/RanjanM1703/'],
  ['karishma.ss@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/dREFw2PSLD/'],
  ['shaswath.g@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/bX7Jx0fFMB/'],
  ['jesudas.t@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/jesudaszion/'],
  ['harish.s@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/Harish_Karthick/'],
  ['jeeveeka.ps@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/jeeveekaps/'],
  ['manuel.b@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/uEDaAImNHJ/'],
  ['premapriya.d@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/Premapriya/'],
  ['prasanth.j@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/jprasanth21/'],
  ['mohammed.rafeeq@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/mohammedrafeeqshariff17/'],
  ['jayavarsan.r@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/user5581XR/'],
  ['adhithyaa.mv@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/AdhithyaaMV/'],
  ['monesh.b@kalvium.community', 'Vels Institute of Science', 'https://leetcode.com/u/Monesh05/'],
].map(([email, campusName, raw]) => ({ email: email!.toLowerCase(), campusName: campusName!, raw: raw! }));

/** `leetcode.com/<handle>` with no `/u/` — the pre-redesign profile URL shape. The
 * shared `resolveLeetcodeProfile` deliberately does not treat this as a profile (see
 * its own comments): a bare `leetcode.com/<anything>` is exactly as likely to be a
 * one-off page as a handle. Extracted here as a *candidate only* — it is never trusted
 * without a live existence check (`verify()` below). */
const LEGACY_PROFILE_PATTERN = /^https?:\/\/(?:www\.)?leetcode\.com\/([A-Za-z0-9_-]{1,39})\/?$/i;
const RESERVED_PATHS = new Set([
  'u', 'settings', 'problemset', 'problems', 'onboarding', 'contest', 'discuss',
  'explore', 'profile', 'accounts', 'static', 'submissions', 'graphql', 'api',
]);

type Resolution =
  | { kind: 'NO_PROFILE_SUPPLIED' }
  | { kind: 'CANDIDATE'; username: string; needsLiveConfirmation: boolean }
  | { kind: 'NOT_A_PROFILE'; reason: string };

function resolveRow(raw: string): Resolution {
  if (raw.trim().toUpperCase() === 'NO PROFILE') return { kind: 'NO_PROFILE_SUPPLIED' };

  const shared = resolveLeetcodeProfile(raw);
  if (shared.username) {
    return { kind: 'CANDIDATE', username: shared.username, needsLiveConfirmation: shared.needsVerification };
  }

  const legacy = LEGACY_PROFILE_PATTERN.exec(raw.trim());
  if (legacy?.[1] && !RESERVED_PATHS.has(legacy[1].toLowerCase())) {
    // A legacy-style URL. Not accepted on format alone — must resolve live.
    return { kind: 'CANDIDATE', username: legacy[1], needsLiveConfirmation: true };
  }

  return {
    kind: 'NOT_A_PROFILE',
    reason:
      shared.resolution === 'FOREIGN_URL'
        ? `"${raw}" points somewhere other than LeetCode (a share/redirect link) — not a LeetCode profile.`
        : shared.resolution === 'NON_PROFILE_URL'
          ? `"${raw}" is a generic LeetCode page, not a profile.`
          : `"${raw}" could not be read as a LeetCode profile URL or handle.`,
  };
}

async function main(): Promise<void> {
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

  // --- Duplicate emails within the supplied table (should never happen; refuse if so) --
  const seen = new Set<string>();
  for (const row of ROWS) {
    if (seen.has(row.email)) throw new Error(`Duplicate email in the supplied table: ${row.email}`);
    seen.add(row.email);
  }

  // --- Duplicate *usernames* within the supplied table: never assign either -----------
  const byUsername = new Map<string, string[]>();
  for (const row of ROWS) {
    const resolution = resolveRow(row.raw);
    if (resolution.kind !== 'CANDIDATE') continue;
    const key = resolution.username.toLowerCase();
    const list = byUsername.get(key) ?? [];
    list.push(row.email);
    byUsername.set(key, list);
  }
  const collidingUsernames = new Set(
    [...byUsername.entries()].filter(([, emails]) => emails.length > 1).map(([u]) => u),
  );
  if (collidingUsernames.size > 0) {
    console.log('  Username collisions WITHIN the supplied table (neither side will be written):');
    for (const username of collidingUsernames) {
      console.log(`    "${username}" supplied for: ${byUsername.get(username)!.join(', ')}`);
    }
    console.log();
  }

  // --- Config + provider for live verification -----------------------------------------
  const config = loadConfiguration();
  const provider = new LeetCodeProvider(config);

  async function liveExists(username: string): Promise<'EXISTS' | 'NOT_FOUND' | 'UNKNOWN'> {
    try {
      await provider.fetchUserProfile(username);
      return 'EXISTS';
    } catch (error) {
      if (isProviderError(error) && error.name === 'ProviderUserNotFoundError') return 'NOT_FOUND';
      console.log(`    ! live check failed for "${username}": ${(error as Error).message} (treated as unverifiable, not written)`);
      return 'UNKNOWN';
    }
  }

  // --- Campus resolution (must already exist — this script creates no campuses) --------
  const campusNames = [...new Set(ROWS.map((r) => r.campusName))];
  const campusIdByName = new Map<string, string>();
  for (const name of campusNames) {
    const aliasCode = CAMPUS_ALIASES[name];
    const campus = aliasCode
      ? await prisma.campus.findUnique({ where: { code: aliasCode } })
      : await prisma.campus.findUnique({ where: { name } });
    if (!campus) throw new Error(`Campus "${name}" (alias "${aliasCode ?? '—'}") does not exist. Refusing.`);
    campusIdByName.set(name, campus.id);
  }

  // --- Per-row processing -----------------------------------------------------------
  const matched: string[] = [];
  const missing: string[] = [];
  const campusChanges: string[] = [];
  const usernameUpdates: string[] = [];
  const usernameNoops: string[] = [];
  const usernameConflicts: string[] = [];
  const invalidLinks: string[] = [];
  const stillNoProfile: string[] = [];
  const skippedCollisions: string[] = [];

  for (const row of ROWS) {
    const student = await prisma.student.findFirst({
      where: { email: { equals: row.email, mode: 'insensitive' } },
      include: { infosysEnrollment: true },
    });
    if (!student) {
      missing.push(row.email);
      continue;
    }
    matched.push(row.email);

    // Safety rail: this script only ever touches `leetcodeUsername` for a student who
    // is genuinely Infosys-only (see the file banner). If a future run of this file
    // finds an active Coding-Hours student on this list, it must not silently rewrite
    // their handle.
    if (student.status === 'ACTIVE') {
      throw new Error(
        `${row.email} is an ACTIVE Coding-Hours student — refusing to touch leetcodeUsername. ` +
          'This script is only safe for Infosys-only (ARCHIVED, no Coding-Hours campus) students.',
      );
    }
    if (!student.infosysEnrollment) {
      throw new Error(`${row.email} matched a student with no InfosysEnrollment — run the roster import first.`);
    }

    // --- Campus ---
    const targetCampusId = campusIdByName.get(row.campusName)!;
    if (student.infosysEnrollment.campusId !== targetCampusId) {
      campusChanges.push(`${row.email}: campus would change to "${row.campusName}"`);
      if (APPLY) {
        await prisma.infosysEnrollment.update({
          where: { studentId: student.id },
          data: { campusId: targetCampusId },
        });
      }
    }

    // --- Username ---
    const resolution = resolveRow(row.raw);
    const current = student.leetcodeUsername;

    if (resolution.kind === 'NO_PROFILE_SUPPLIED') {
      if (!current) stillNoProfile.push(row.email);
      // Never blank an existing handle just because this batch supplied nothing.
      continue;
    }

    if (resolution.kind === 'NOT_A_PROFILE') {
      invalidLinks.push(`${row.email}: ${resolution.reason}`);
      continue;
    }

    // resolution.kind === 'CANDIDATE'
    if (collidingUsernames.has(resolution.username.toLowerCase())) {
      skippedCollisions.push(`${row.email}: supplied "${resolution.username}" collides with another row in this batch — not written`);
      continue;
    }

    if (current && current.toLowerCase() === resolution.username.toLowerCase()) {
      usernameNoops.push(row.email);
      continue;
    }

    const existingElsewhere = await prisma.student.findFirst({
      where: { leetcodeUsername: { equals: resolution.username, mode: 'insensitive' }, id: { not: student.id } },
      select: { email: true },
    });
    if (existingElsewhere) {
      usernameConflicts.push(
        `${row.email}: supplied "${resolution.username}" is already assigned to ${existingElsewhere.email} in the database — not written`,
      );
      continue;
    }

    if (current) {
      // Roster and database disagree. Verify both live; keep whichever resolves
      // (per [[roster-urls-go-stale-verify-live]]). If both resolve, this is a genuine
      // ambiguity a human must settle — do not guess.
      const [suppliedLive, currentLive] = await Promise.all([liveExists(resolution.username), liveExists(current)]);
      if (suppliedLive === 'EXISTS' && currentLive !== 'EXISTS') {
        usernameUpdates.push(`${row.email}: "${current}" -> "${resolution.username}" (current did not resolve live, supplied did)`);
        if (APPLY) await writeUsername(student.id, resolution.username);
      } else if (currentLive === 'EXISTS' && suppliedLive !== 'EXISTS') {
        usernameConflicts.push(`${row.email}: kept existing "${current}" — supplied "${resolution.username}" does not resolve live`);
      } else {
        usernameConflicts.push(
          `${row.email}: DB has "${current}" (live: ${currentLive}), supplied "${resolution.username}" (live: ${suppliedLive}) — both/neither resolved, needs a human`,
        );
      }
      continue;
    }

    // No existing username — verify the new one live before writing (legacy-style URLs
    // and page-title derivations are *never* trusted on format alone).
    const live = await liveExists(resolution.username);
    if (live === 'EXISTS') {
      usernameUpdates.push(`${row.email}: (none) -> "${resolution.username}"`);
      if (APPLY) await writeUsername(student.id, resolution.username);
    } else if (live === 'NOT_FOUND') {
      invalidLinks.push(`${row.email}: supplied handle "${resolution.username}" (from "${row.raw}") does not resolve on LeetCode — not written`);
    } else {
      invalidLinks.push(`${row.email}: could not verify "${resolution.username}" live (transient failure) — not written, retry later`);
    }
  }

  async function writeUsername(studentId: string, username: string): Promise<void> {
    await prisma.student.update({ where: { id: studentId }, data: { leetcodeUsername: username } });
    // Force the next sync to treat this as a fresh profile rather than trusting a
    // cache taken before the handle existed here.
    await prisma.studentSyncState.updateMany({
      where: { studentId },
      data: { providerProfileFetchedAt: null },
    });
  }

  // --- Report -----------------------------------------------------------------------
  const line = (label: string, value: number | string): void => console.log(`  ${label.padEnd(46)} ${value}`);
  console.log('Summary');
  line('Rows in supplied table:', ROWS.length);
  line('Matched existing Infosys students:', matched.length);
  line('Missing (no student with this email):', missing.length);
  line('Campus would change:', campusChanges.length);
  line('Usernames updated:', usernameUpdates.length);
  line('Usernames unchanged (already correct):', usernameNoops.length);
  line('Username conflicts (not written, needs review):', usernameConflicts.length);
  line('Within-batch username collisions (not written):', skippedCollisions.length);
  line('Invalid/unresolvable links (not written):', invalidLinks.length);
  line('Still PROFILE_NOT_LINKED (NO PROFILE supplied, none on file):', stillNoProfile.length);
  console.log();

  const section = (title: string, rows: string[]): void => {
    if (rows.length === 0) return;
    console.log(`--- ${title} ---`);
    for (const row of rows) console.log(`  ${row}`);
    console.log();
  };
  section('Missing emails', missing);
  section('Campus changes', campusChanges);
  section('Username updates', usernameUpdates);
  section('Username conflicts — needs a human', usernameConflicts);
  section('Within-batch collisions — needs a human', skippedCollisions);
  section('Invalid/unresolvable links — needs a human', invalidLinks);

  if (!APPLY) console.log('Nothing was written. Re-run with --apply.');
}

main()
  .catch((error: Error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
