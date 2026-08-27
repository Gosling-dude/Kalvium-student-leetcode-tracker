/**
 * Campus isolation for entities addressed *by id*, against a real database.
 *
 * `mentor-dashboard-scope.e2e-spec.ts` covers the filter-shaped endpoints, where the
 * question is "which campus does this aggregate run under". This covers the other shape:
 * an assignment, a baseline test or an attempt fetched by its own id, which skips every
 * list-level filter there is. A mentor who never sees another campus's assignment in a
 * list can still paste its id into the URL, and until this was added they were served it.
 *
 * Three properties, each of which failed differently before:
 *
 *  - **Refusal is `NotFoundException`, not `ForbiddenException`.** A 403 confirms the row
 *    exists, which turns ids into a map of what every other campus has been set. "Not
 *    yours" and "does not exist" have to be the same answer.
 *  - **A programme-wide entity (`campusId: null`) is readable but not writable** by a
 *    mentor. It genuinely was set for their campus too, so hiding it would be wrong; but
 *    editing it changes every campus's work, so that stays admin-only.
 *  - **Writes may not target a campus you do not hold**, and — the case that is easy to
 *    miss — may not target *no* campus either, because that means every campus.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MentorScopeService } from './mentor-scope.service';

const prisma = new PrismaClient();
const scope = new MentorScopeService(prisma as never);

const RUN = `e2e-entity-${Date.now()}`;
const CODE = `EN${Date.now().toString(36).toUpperCase()}`;

let vels: string;
let srm: string;
let velsMentor: { id: string; role: 'MENTOR' };
let admin: { id: string; role: 'ADMIN' };

beforeAll(async () => {
  const [v, s] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Vels`, code: `${CODE}V` } }),
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
  ]);
  vels = v.id;
  srm = s.id;

  const mentor = await prisma.user.create({
    data: {
      email: `${RUN}-vels@entity-scope.invalid`,
      name: 'Vels mentor',
      role: 'MENTOR',
      passwordHash: 'x',
      mentorCampuses: { create: { campusId: vels } },
    },
  });
  velsMentor = { id: mentor.id, role: 'MENTOR' };

  const adminUser = await prisma.user.create({
    data: {
      email: `${RUN}-admin@entity-scope.invalid`,
      name: 'Admin',
      role: 'ADMIN',
      passwordHash: 'x',
    },
  });
  admin = { id: adminUser.id, role: 'ADMIN' };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.campus.deleteMany({ where: { id: { in: [vels, srm] } } });
  await prisma.$disconnect();
});

/** The guard as an endpoint calls it: resolve the grants, then check the entity. */
async function check(
  user: { id: string; role: 'MENTOR' | 'ADMIN' },
  campusId: string | null,
  options: { write?: boolean } = {},
): Promise<'allowed' | 'not-found'> {
  const allowed = await scope.allowedCampusIds(user);
  try {
    scope.assertCampusAllowed(campusId, allowed, {
      entity: 'Assignment',
      id: 'fixture-id',
      write: options.write,
    });
    return 'allowed';
  } catch {
    return 'not-found';
  }
}

describe('reading an entity by id', () => {
  it('serves a mentor their own campus’s entity', async () => {
    expect(await check(velsMentor, vels)).toBe('allowed');
  });

  it('refuses another campus’s entity as "not found"', async () => {
    // The cross-campus id attack: the mentor never saw this id in a list, but nothing
    // stopped them pasting it into the URL.
    expect(await check(velsMentor, srm)).toBe('not-found');
  });

  it('shows a programme-wide entity to every mentor', async () => {
    // `campusId: null` was genuinely set for their campus too. Hiding it would remove
    // work their own students were measured against.
    expect(await check(velsMentor, null)).toBe('allowed');
  });

  it('leaves an admin unrestricted', async () => {
    expect(await check(admin, vels)).toBe('allowed');
    expect(await check(admin, srm)).toBe('allowed');
    expect(await check(admin, null)).toBe('allowed');
  });
});

describe('writing to an entity by id', () => {
  it('lets a mentor edit their own campus’s entity', async () => {
    expect(await check(velsMentor, vels, { write: true })).toBe('allowed');
  });

  it('refuses editing another campus’s entity', async () => {
    expect(await check(velsMentor, srm, { write: true })).toBe('not-found');
  });

  it('refuses a mentor editing a programme-wide entity', async () => {
    // Readable, but not editable: changing it changes every campus's work at once.
    expect(await check(velsMentor, null, { write: true })).toBe('not-found');
  });

  it('still lets an admin edit a programme-wide entity', async () => {
    expect(await check(admin, null, { write: true })).toBe('allowed');
  });
});

describe('choosing the campus a new entity targets', () => {
  async function target(
    user: { id: string; role: 'MENTOR' | 'ADMIN' },
    campusId: string | null,
  ): Promise<'allowed' | 'refused'> {
    const allowed = await scope.allowedCampusIds(user);
    try {
      scope.assertCanWriteCampus(campusId, allowed);
      return 'allowed';
    } catch {
      return 'refused';
    }
  }

  it('lets a mentor create for their own campus', async () => {
    expect(await target(velsMentor, vels)).toBe('allowed');
  });

  it('refuses a mentor creating for another campus', async () => {
    expect(await target(velsMentor, srm)).toBe('refused');
  });

  it('refuses a mentor creating for every campus at once', async () => {
    // The quiet one. Omitting the campus on a create form is not a harmless default —
    // it targets the whole programme, so it cannot be pinned the way a read is.
    expect(await target(velsMentor, null)).toBe('refused');
  });

  it('lets an admin target any campus, or all of them', async () => {
    expect(await target(admin, vels)).toBe('allowed');
    expect(await target(admin, srm)).toBe('allowed');
    expect(await target(admin, null)).toBe('allowed');
  });
});

describe('a mentor whose grants were revoked', () => {
  it('loses access to what it could previously read', async () => {
    await prisma.mentorCampus.deleteMany({ where: { userId: velsMentor.id } });
    expect(await check(velsMentor, vels)).toBe('not-found');
    // A programme-wide entity stays readable: `[]` means "no campuses of your own", and
    // an entity belonging to no campus in particular is not any campus's to withhold.
    expect(await check(velsMentor, null)).toBe('allowed');

    await prisma.mentorCampus.create({ data: { userId: velsMentor.id, campusId: vels } });
    expect(await check(velsMentor, vels)).toBe('allowed');
  });
});
