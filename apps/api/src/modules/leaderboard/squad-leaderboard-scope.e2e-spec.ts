/**
 * The squad leaderboard must show a mentor only their own campus's squads.
 *
 * Unlike the endpoints that took a `?campus=` and resolved it without asking who was
 * calling, this one never accepted a campus at all — so there was nothing to get wrong
 * and nothing to notice. Every mentor received every campus's squads and their averages.
 * Verified in production against the pre-fix build: a Vels mentor was served all twelve
 * squads across three campuses.
 *
 * The filter is in the query rather than a slice of the result, so `rank` keeps meaning
 * "how many squads did better" across the whole programme. A mentor sees their squads'
 * real standing; renumbering the visible rows 1..n would quietly turn a fourth-place squad
 * into a first-place one.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeaderboardService } from './leaderboard.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-squadlb-${Date.now()}`;
const CODE = `SL${Date.now().toString(36).toUpperCase()}`;

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
/** No cache, so each call re-reads — the scope must come from the query, not a cache key. */
const noCache = {
  remember: async <T>(_key: string, _ttl: number, load: () => Promise<T>): Promise<T> => load(),
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
} as never;
const service = new LeaderboardService(prisma as never, noCache, time);

let vels: string;
let srm: string;
let periodKey: string;
const squadIds: string[] = [];

beforeAll(async () => {
  const [v, s] = await Promise.all([
    prisma.campus.create({ data: { name: `${RUN} Vels`, code: `${CODE}V` } }),
    prisma.campus.create({ data: { name: `${RUN} SRM`, code: `${CODE}S` } }),
  ]);
  vels = v.id;
  srm = s.id;

  const day = time.today();
  periodKey = day;

  // Two squads per campus, interleaved by rank so a campus filter cannot be mistaken for
  // "the top half of the board".
  const spec: { name: string; campusId: string; rank: number }[] = [
    { name: `${RUN} Vels A`, campusId: vels, rank: 1 },
    { name: `${RUN} SRM A`, campusId: srm, rank: 2 },
    { name: `${RUN} Vels B`, campusId: vels, rank: 3 },
    { name: `${RUN} SRM B`, campusId: srm, rank: 4 },
  ];

  for (const entry of spec) {
    const squad = await prisma.squad.create({
      data: { name: entry.name, campusId: entry.campusId },
    });
    squadIds.push(squad.id);
    await prisma.squadLeaderboardEntry.create({
      data: {
        squadId: squad.id,
        period: 'DAILY',
        periodKey,
        rank: entry.rank,
        isTied: false,
        memberCount: 5,
        averageCompletion: 50,
        totalSolved: 10,
        averageStreak: 1,
      },
    });
  }
});

afterAll(async () => {
  await prisma.squadLeaderboardEntry.deleteMany({ where: { squadId: { in: squadIds } } });
  await prisma.squad.deleteMany({ where: { id: { in: squadIds } } });
  await prisma.campus.deleteMany({ where: { id: { in: [vels, srm] } } });
  await prisma.$disconnect();
});

/** Only this suite's fixtures — the shared database holds other squads. */
const mine = <T extends { name: string }>(rows: T[]): T[] =>
  rows.filter((row) => row.name.startsWith(RUN));

describe('squad leaderboard', () => {
  it('gives an admin every campus’s squads', async () => {
    const rows = mine(await service.getSquadLeaderboard('DAILY', periodKey, null));
    expect(rows.map((row) => row.name).sort()).toEqual([
      `${RUN} SRM A`,
      `${RUN} SRM B`,
      `${RUN} Vels A`,
      `${RUN} Vels B`,
    ]);
  });

  it('gives a mentor only their own campus’s squads', async () => {
    const rows = mine(await service.getSquadLeaderboard('DAILY', periodKey, [vels]));
    expect(rows.map((row) => row.name).sort()).toEqual([`${RUN} Vels A`, `${RUN} Vels B`]);
  });

  it('never leaks the other campus’s squad names', async () => {
    const rows = mine(await service.getSquadLeaderboard('DAILY', periodKey, [srm]));
    expect(JSON.stringify(rows)).not.toContain('Vels');
  });

  it('keeps cohort rank rather than renumbering the visible rows', async () => {
    // Vels holds ranks 1 and 3 of the four. A filtered board that renumbered them 1 and 2
    // would tell the mentor their second squad is doing better than it is.
    const rows = mine(await service.getSquadLeaderboard('DAILY', periodKey, [vels]));
    expect(rows.map((row) => row.rank)).toEqual([1, 3]);
  });

  it('shows a mentor with no grants nothing', async () => {
    expect(mine(await service.getSquadLeaderboard('DAILY', periodKey, []))).toHaveLength(0);
  });

  it('shows both campuses to a mentor granted both', async () => {
    const rows = mine(await service.getSquadLeaderboard('DAILY', periodKey, [vels, srm]));
    expect(rows).toHaveLength(4);
  });
});
