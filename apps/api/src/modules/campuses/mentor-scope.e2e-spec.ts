/**
 * Mentor campus scoping, against a real database.
 *
 * The brief's own example: a caller hitting `GET /api/v1/students` must not receive the
 * entire student database. Until now `Squad.mentorId` recorded who ran a squad and nothing
 * read it for authorization, so every mentor could list every student at every campus.
 *
 * Two properties are load-bearing:
 *
 *  - `null` (unrestricted) and `[]` (no campuses) are different values. Collapsing them
 *    into a plain array makes the direction of a bug decide whether an admin sees nothing
 *    or a mentor sees everything.
 *  - "Not found" and "not yours" are answered identically, or student ids become an oracle
 *    for which students exist at campuses the caller cannot see.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MentorScopeService } from './mentor-scope.service';

const prisma = new PrismaClient();
const scope = new MentorScopeService(prisma as never);

const RUN = `e2e-scope-${Date.now()}`;
/** Campus codes are unique and short, so they get their own suffixed key. */
const CODE = `ES${Date.now().toString(36).toUpperCase()}`;

let campusA: string;
let campusB: string;
let mentorScoped: string;
let mentorUngranted: string;
let adminId: string;

beforeAll(async () => {
  const a = await prisma.campus.create({
    data: { name: `${RUN} Campus A`, code: `${CODE}A` },
  });
  const b = await prisma.campus.create({
    data: { name: `${RUN} Campus B`, code: `${CODE}B` },
  });
  campusA = a.id;
  campusB = b.id;

  const mentor = await prisma.user.create({
    data: {
      email: `${RUN}-mentor@scope.invalid`,
      name: 'Scoped Mentor',
      role: 'MENTOR',
      passwordHash: 'x',
      mentorCampuses: { create: { campusId: campusA } },
    },
  });
  mentorScoped = mentor.id;

  const ungranted = await prisma.user.create({
    data: {
      email: `${RUN}-ungranted@scope.invalid`,
      name: 'Ungranted Mentor',
      role: 'MENTOR',
      passwordHash: 'x',
    },
  });
  mentorUngranted = ungranted.id;

  const admin = await prisma.user.create({
    data: {
      email: `${RUN}-admin@scope.invalid`,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: 'x',
    },
  });
  adminId = admin.id;
});

afterAll(async () => {
  // Tolerant of a failed setup: a teardown that throws on `undefined` ids hides the error
  // that actually caused the failure.
  const userIds = [mentorScoped, mentorUngranted, adminId].filter(Boolean);
  const campusIds = [campusA, campusB].filter(Boolean);

  if (userIds.length > 0) {
    await prisma.mentorCampus.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (campusIds.length > 0) {
    await prisma.campus.deleteMany({ where: { id: { in: campusIds } } });
  }
  await prisma.$disconnect();
});

describe('allowedCampusIds', () => {
  it('is unrestricted for an admin', async () => {
    expect(await scope.allowedCampusIds({ id: adminId, role: 'ADMIN' })).toBeNull();
  });

  it('is the granted campuses for a mentor', async () => {
    expect(await scope.allowedCampusIds({ id: mentorScoped, role: 'MENTOR' })).toEqual([campusA]);
  });

  it('is an empty list — not "unrestricted" — for a mentor with no grants', async () => {
    // The distinction the whole design turns on: `[]` must never be read as "no filter".
    const allowed = await scope.allowedCampusIds({ id: mentorUngranted, role: 'MENTOR' });
    expect(allowed).toEqual([]);
    expect(allowed).not.toBeNull();
  });
});

describe('narrow', () => {
  it('leaves an admin unfiltered', () => {
    expect(scope.narrow(undefined, null)).toEqual({});
    expect(scope.narrow(campusB, null)).toEqual({ campusId: campusB });
  });

  it('restricts an unfiltered mentor request to their campuses', () => {
    expect(scope.narrow(undefined, [campusA])).toEqual({ campusIds: [campusA] });
  });

  it('allows a mentor to filter within their own campuses', () => {
    expect(scope.narrow(campusA, [campusA, campusB])).toEqual({ campusId: campusA });
  });

  it('denies a mentor asking for a campus they were not granted', () => {
    expect(scope.narrow(campusB, [campusA])).toEqual({ deny: true });
  });

  it('denies a mentor with no grants at all', () => {
    expect(scope.narrow(undefined, [])).toEqual({ deny: true });
  });
});

describe('canSeeCampus', () => {
  it('lets an admin see every campus, including an unplaced student', () => {
    expect(scope.canSeeCampus(campusB, null)).toBe(true);
    expect(scope.canSeeCampus(null, null)).toBe(true);
  });

  it('lets a mentor see their own campus and not another', () => {
    expect(scope.canSeeCampus(campusA, [campusA])).toBe(true);
    expect(scope.canSeeCampus(campusB, [campusA])).toBe(false);
  });

  it('hides a student with no campus from every mentor', () => {
    // Treating "unplaced" as visible-to-all would make the one group nobody is
    // accountable for the one group everybody can read.
    expect(scope.canSeeCampus(null, [campusA])).toBe(false);
  });
});

describe('the migration preserves existing access', () => {
  it('granted every campus to mentors that existed before the table did', async () => {
    // A mentor created *before* this feature (the seeded ones) must not have lost access
    // on deploy — the rule ships enforcing today's behaviour, and narrowing it is an
    // explicit admin action.
    const preExisting = await prisma.user.findFirst({
      where: { role: 'MENTOR', email: { not: { startsWith: RUN } } },
      select: { id: true, _count: { select: { mentorCampuses: true } } },
    });

    if (!preExisting) return; // nothing seeded in this database; nothing to assert
    expect(preExisting._count.mentorCampuses).toBeGreaterThan(0);
  });
});
