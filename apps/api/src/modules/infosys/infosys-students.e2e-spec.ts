/**
 * `InfosysStudentsService.update` against a real database — the interactive editor's
 * safety rules (§2 of the 2026-09-23 feature brief): a profile is verified live before
 * saving, never trusted on format alone, never overwrites a valid handle with something
 * invalid, never assigned as a duplicate, and a successful profile change recomputes the
 * student's whole Infosys history automatically.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysStudentsService } from './infosys-students.service';
import { ProviderUserNotFoundError } from '../providers/provider.errors';

const prisma = new PrismaClient();
const RUN = `e2e-infosysedit-${Date.now()}`;
const CODE = `IU${Date.now().toString(36).toUpperCase()}`;

const time = {
  bounds: (dayKey: string) => ({
    start: new Date(`${dayKey}T00:00:00.000Z`),
    end: new Date(`${dayKey}T23:59:59.999Z`),
  }),
} as never;

const KNOWN_USERS = new Set(['valid-user', 'taken-user', 'existing-user']);
const provider = {
  name: 'leetcode',
  fetchUserProfile: async (username: string) => {
    if (!KNOWN_USERS.has(username.toLowerCase())) throw new ProviderUserNotFoundError(username);
    return { username, totalSolved: 0, ranking: 0 } as never;
  },
} as never;

const rollup = new InfosysRollupService(prisma as never, time);
const analytics = new InfosysAnalyticsService(prisma as never, rollup);
const service = new InfosysStudentsService(prisma as never, rollup, analytics, provider);

let campusA: string;
let campusB: string;
let problemId: string;
const dayKey = '2026-09-21';

let target: string;
let holderOfTakenUser: string;
let activeStudent: string;

beforeAll(async () => {
  const [ca, cb] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} A`, code: `${CODE}A` } }),
    prisma.campus.create({ data: { name: `${RUN} B`, code: `${CODE}B` } }),
  ]);
  campusA = ca.id;
  campusB = cb.id;

  const problem = await prisma.problem.create({
    data: {
      titleSlug: `${RUN}-two-sum`,
      title: `${RUN}-two-sum`,
      difficulty: 'EASY',
      url: `https://leetcode.com/problems/${RUN}-two-sum/`,
    },
  });
  problemId = problem.id;
  await prisma.infosysAssignment.create({
    data: { dayKey, problems: { create: [{ problemId, position: 1 }] } },
  });

  const [t, holder, active] = await Promise.all([
    prisma.student.create({
      data: {
        name: `${RUN} Target`,
        email: `${RUN}-target@kalvium.community`.toLowerCase(),
        status: 'ARCHIVED',
        // A real sync has already run OK for this student — the fixture for "gains a
        // profile" is someone whose sync infrastructure already works, not someone also
        // mid-first-sync (that combination is `resolveProfileState`'s DATA_UNAVAILABLE
        // case, a different scenario from this test).
        syncState: { create: { status: 'OK' } },
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Holder`,
        email: `${RUN}-holder@kalvium.community`.toLowerCase(),
        status: 'ARCHIVED',
        leetcodeUsername: 'taken-user',
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
    prisma.student.create({
      data: {
        name: `${RUN} Active`,
        status: 'ACTIVE',
        campusId: campusA,
        infosysEnrollment: { create: { campusId: campusA } },
      },
    }),
  ]);
  target = t.id;
  holderOfTakenUser = holder.id;
  activeStudent = active.id;
});

afterAll(async () => {
  const ids = [target, holderOfTakenUser, activeStudent];
  await prisma.infosysDailyProblemStatus.deleteMany({ where: { infosysDailyStatus: { studentId: { in: ids } } } });
  await prisma.infosysDailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.infosysAssignment.deleteMany({ where: { dayKey } });
  await prisma.problem.delete({ where: { id: problemId } });
  await prisma.infosysEnrollment.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
  await prisma.$disconnect();
});

describe('InfosysStudentsService.update', () => {
  it('updates name, email and campus together', async () => {
    const updated = await service.update(target, {
      name: `${RUN} Target Renamed`,
      email: `${RUN}-target2@kalvium.community`.toLowerCase(),
      campusId: campusB,
    });
    expect(updated.name).toBe(`${RUN} Target Renamed`);
    expect(updated.campusName).toBe(`${RUN} B`);

    const enrollment = await prisma.infosysEnrollment.findUnique({ where: { studentId: target } });
    expect(enrollment?.campusId).toBe(campusB);
  });

  it('rejects an email already used by another student', async () => {
    await expect(
      service.update(target, { email: `${RUN}-holder@kalvium.community`.toLowerCase() }),
    ).rejects.toThrow(/already used/);
  });

  it('rejects an unresolvable LeetCode link and leaves the profile untouched', async () => {
    await expect(service.update(target, { leetcodeProfileUrl: 'not a url at all @@@' })).rejects.toThrow();
    const student = await prisma.student.findUnique({ where: { id: target } });
    expect(student?.leetcodeUsername).toBeNull();
  });

  it('rejects a handle that does not resolve live on LeetCode', async () => {
    await expect(
      service.update(target, { leetcodeProfileUrl: 'https://leetcode.com/u/does-not-exist/' }),
    ).rejects.toThrow(/does not resolve/);
    const student = await prisma.student.findUnique({ where: { id: target } });
    expect(student?.leetcodeUsername).toBeNull();
  });

  it('rejects a username already assigned to another student — neither side is written', async () => {
    await expect(
      service.update(target, { leetcodeProfileUrl: 'https://leetcode.com/u/taken-user/' }),
    ).rejects.toThrow(/already assigned/);
    const student = await prisma.student.findUnique({ where: { id: target } });
    expect(student?.leetcodeUsername).toBeNull();
    const holder = await prisma.student.findUnique({ where: { id: holderOfTakenUser } });
    expect(holder?.leetcodeUsername).toBe('taken-user');
  });

  it('a valid, live-verified profile is saved and triggers historical recomputation', async () => {
    const updated = await service.update(target, { leetcodeProfileUrl: 'https://leetcode.com/u/valid-user/' });
    expect(updated.leetcodeUsername).toBe('valid-user');
    expect(updated.profileState).toBe('OK');

    // recomputeStudent ran: the assigned day now has a real InfosysDailyStatus row for
    // this student, not the "no profile" placeholder counts.
    const status = await prisma.infosysDailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: target, dayKey } },
    });
    expect(status).not.toBeNull();
    expect(status!.profileNotLinkedCount).toBe(0);
  });

  it('re-submitting the same profile is a no-op — never re-verified, never blanked', async () => {
    const updated = await service.update(target, { leetcodeProfileUrl: 'https://leetcode.com/u/valid-user/' });
    expect(updated.leetcodeUsername).toBe('valid-user');
  });

  it('a blank profile field on an otherwise-valid update never blanks an existing profile', async () => {
    const updated = await service.update(target, { name: `${RUN} Target Renamed Again` });
    expect(updated.leetcodeUsername).toBe('valid-user');
  });

  it('an explicit empty string clears an existing profile', async () => {
    const updated = await service.update(target, { leetcodeProfileUrl: '' });
    expect(updated.leetcodeUsername).toBeNull();
    expect(updated.profileState).toBe('PROFILE_NOT_LINKED');
  });

  it('refuses to edit a student with an active Coding-Hours record', async () => {
    await expect(service.update(activeStudent, { name: 'Should not apply' })).rejects.toThrow(
      /active Coding-Hours record/,
    );
  });

  it('404s for a student with no Infosys enrollment at all', async () => {
    await expect(
      service.update('00000000-0000-0000-0000-000000000000', { name: 'Nobody' }),
    ).rejects.toThrow();
  });
});
