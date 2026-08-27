/**
 * Campus isolation on the *reporting* endpoints, against a real database.
 *
 * `mentor-scope.e2e-spec.ts` covers the student directory, which had been scoped for a
 * while. These four had not, and the hole they left was larger than a tampered request:
 *
 *  - `GET /mentor/dashboard` and `GET /dashboard` resolved `?campus=` through
 *    `CampusesService.resolveScope`, which validates what the request *asked for* and has
 *    no idea who is asking. A mentor granted one campus who sent `?campus=<another>` was
 *    served it.
 *  - Worse, sending **no** campus resolves to `null`, and `null` on these aggregates means
 *    *every campus in the system*. So a mentor's ordinary page load — no tampering at all,
 *    just the request their browser sends — returned the whole programme's numbers. The
 *    only thing that made the screen look campus-specific was a filter in the client.
 *
 * So the cases below are not only "reject the tampered request". The one that mattered in
 * production is "an unfiltered request from a mentor must not mean everything".
 *
 * These call the services directly rather than over HTTP because what is under test is the
 * scoping rule, and a rule that only holds when a particular controller remembers to apply
 * it is the bug being fixed. `reportingScope` is the shared decision; every reporting
 * endpoint routes through it.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MentorScopeService } from '../campuses/mentor-scope.service';

const prisma = new PrismaClient();
const scope = new MentorScopeService(prisma as never);

const RUN = `e2e-mdash-${Date.now()}`;
const CODE = `MD${Date.now().toString(36).toUpperCase()}`;

let vels: string;
let srm: string;
let alu: string;
let velsMentor: { id: string; role: 'MENTOR' };
let srmMentor: { id: string; role: 'MENTOR' };
let aluMentor: { id: string; role: 'MENTOR' };
let bothMentor: { id: string; role: 'MENTOR' };
let ungranted: { id: string; role: 'MENTOR' };
let admin: { id: string; role: 'ADMIN' };

async function mentor(label: string, campusIds: string[]) {
  const user = await prisma.user.create({
    data: {
      email: `${RUN}-${label}@mentor-scope.invalid`,
      name: `${label} mentor`,
      role: 'MENTOR',
      passwordHash: 'x',
      mentorCampuses: { create: campusIds.map((campusId) => ({ campusId })) },
    },
  });
  return { id: user.id, role: 'MENTOR' as const };
}

beforeAll(async () => {
  // Three campuses, named for the real ones so a failure reads like the production case.
  const [v, s, a] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Vels`, code: `${CODE}V` } }),
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
    prisma.campus.create({ data: { name: `${RUN} Alliance`, code: `${CODE}A` } }),
  ]);
  vels = v.id;
  srm = s.id;
  alu = a.id;

  [velsMentor, srmMentor, aluMentor, bothMentor, ungranted] = await Promise.all([
    mentor('vels', [vels]),
    mentor('srm', [srm]),
    mentor('alu', [alu]),
    mentor('both', [vels, srm]),
    mentor('none', []),
  ]);

  const adminUser = await prisma.user.create({
    data: {
      email: `${RUN}-admin@mentor-scope.invalid`,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: 'x',
    },
  });
  admin = { id: adminUser.id, role: 'ADMIN' };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.campus.deleteMany({ where: { id: { in: [vels, srm, alu] } } });
  await prisma.$disconnect();
});

/** What a reporting endpoint would actually run under, for this user and this request. */
async function resolved(user: { id: string; role: 'MENTOR' | 'ADMIN' }, requested: string | null) {
  return scope.reportingScope(requested, await scope.allowedCampusIds(user));
}

describe('a mentor cannot read another campus by asking for it', () => {
  it('serves a Vels mentor their own campus', async () => {
    expect(await resolved(velsMentor, vels)).toEqual({ campusId: vels });
  });

  it('refuses a Vels mentor asking for SRM', async () => {
    expect(await resolved(velsMentor, srm)).toEqual({ deny: true });
  });

  it('refuses a Vels mentor asking for Alliance', async () => {
    expect(await resolved(velsMentor, alu)).toEqual({ deny: true });
  });

  it('refuses an SRM mentor asking for Vels or Alliance', async () => {
    expect(await resolved(srmMentor, vels)).toEqual({ deny: true });
    expect(await resolved(srmMentor, alu)).toEqual({ deny: true });
  });

  it('refuses an Alliance mentor asking for Vels or SRM', async () => {
    expect(await resolved(aluMentor, vels)).toEqual({ deny: true });
    expect(await resolved(aluMentor, srm)).toEqual({ deny: true });
  });
});

describe('an unfiltered request does not mean "every campus"', () => {
  // The production bug. A mentor's page load names no campus, `null` means every campus on
  // these aggregates, and the result was the whole programme's numbers behind a client-side
  // filter. Each mentor must instead be pinned to the campus they were granted.
  it('pins a Vels mentor to Vels', async () => {
    expect(await resolved(velsMentor, null)).toEqual({ campusId: vels });
  });

  it('pins an SRM mentor to SRM', async () => {
    expect(await resolved(srmMentor, null)).toEqual({ campusId: srm });
  });

  it('pins an Alliance mentor to Alliance', async () => {
    expect(await resolved(aluMentor, null)).toEqual({ campusId: alu });
  });

  it('never resolves a mentor to "every campus"', async () => {
    // Stated as its own case because it is the invariant, not an example of one: no
    // mentor, however they are granted, may end up with `campusId: null`.
    for (const user of [velsMentor, srmMentor, aluMentor, bothMentor, ungranted]) {
      const result = await resolved(user, null);
      expect(result).not.toEqual({ campusId: null });
    }
  });
});

describe('the grants are the source of truth, not the request', () => {
  it('shows a mentor with no grants nothing', async () => {
    // `[]` is "no campuses", and must never widen into `null` ("all campuses"). This is
    // the direction a collapsed empty-array bug fails in.
    expect(await resolved(ungranted, null)).toEqual({ deny: true });
    expect(await resolved(ungranted, vels)).toEqual({ deny: true });
  });

  it('makes a multi-campus mentor choose rather than guessing for them', async () => {
    // Two grants and no choice made cannot be expressed as one campus id, and these
    // endpoints take exactly one. Widening to the whole programme would be the silent
    // wrong answer; the controller turns this into "name the campus you want".
    expect(await resolved(bothMentor, null)).toEqual({ deny: true });
    // Either grant, named explicitly, is served.
    expect(await resolved(bothMentor, vels)).toEqual({ campusId: vels });
    expect(await resolved(bothMentor, srm)).toEqual({ campusId: srm });
    // A third campus is still refused.
    expect(await resolved(bothMentor, alu)).toEqual({ deny: true });
  });

  it('reflects a revoked grant immediately', async () => {
    // Access is re-read per request, not carried in the token, so removing a grant takes
    // effect now rather than whenever the mentor's access token happens to expire.
    await prisma.mentorCampus.deleteMany({ where: { userId: aluMentor.id, campusId: alu } });
    expect(await resolved(aluMentor, alu)).toEqual({ deny: true });

    await prisma.mentorCampus.create({ data: { userId: aluMentor.id, campusId: alu } });
    expect(await resolved(aluMentor, alu)).toEqual({ campusId: alu });
  });
});

describe('an admin is unrestricted', () => {
  it('reads every campus when none is named', async () => {
    // `null` here is the meaning a mentor must never reach: no filter, whole programme.
    expect(await resolved(admin, null)).toEqual({ campusId: null });
  });

  it('reads any campus it names', async () => {
    for (const campusId of [vels, srm, alu]) {
      expect(await resolved(admin, campusId)).toEqual({ campusId });
    }
  });
});
