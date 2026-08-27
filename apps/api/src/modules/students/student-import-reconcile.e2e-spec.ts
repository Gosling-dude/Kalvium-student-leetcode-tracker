/**
 * Roster reconciliation, verified against a real database.
 *
 * `archiveAbsent` is the most destructive thing the importer can be asked to do, and the
 * whole point of it is what it *does not* destroy: a student who leaves keeps every
 * submission, daily status, baseline result and placement row they ever had, because
 * every historical report about a day they were present has to keep resolving them.
 * Testing that against a mocked Prisma would prove nothing — the claim is about what
 * survives in the database, so this runs against a real one.
 *
 * The suite builds its own throwaway campus rather than borrowing VELS. Reconciliation is
 * campus-wide by definition: pointed at a shared fixture campus it would archive whatever
 * else happened to be living there, which is exactly the blast radius these tests exist to
 * pin down.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { StudentImportService, type ParsedRow } from './student-import.service';
import { BatchesService } from '../batches/batches.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-reconcile-${Date.now()}`;
const CAMPUS_CODE = `RC${Date.now().toString().slice(-8)}`;

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const noCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
} as never;
const batches = new BatchesService(prisma as never, time, noCache);
const importer = new StudentImportService(prisma as never, batches, time);

let campusId: string;
let otherCampusId: string;

/** A roster row as the internal endpoint would hand it over. */
function row(
  input: { name: string; leetcode?: string; squad?: string; email?: string },
  index: number,
): ParsedRow {
  return importer.toParsedRow(
    {
      name: input.name,
      email: input.email ?? '',
      squad: input.squad ?? '',
      batch: '',
      leetcode: input.leetcode ?? '',
      registerNumber: '',
      phone: '',
    },
    index + 2,
  );
}

const active = (name: string) =>
  prisma.student.findFirst({ where: { campusId, name }, select: { id: true, status: true } });

async function rosterOf(id: string): Promise<string[]> {
  const students = await prisma.student.findMany({
    where: { campusId: id, status: 'ACTIVE' },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return students.map((student) => student.name);
}

beforeAll(async () => {
  const campus = await prisma.campus.create({
    data: { name: `Reconcile Fixture ${RUN}`, code: CAMPUS_CODE },
  });
  campusId = campus.id;

  const other = await prisma.campus.create({
    data: { name: `Bystander Fixture ${RUN}`, code: `${CAMPUS_CODE}X` },
  });
  otherCampusId = other.id;
});

afterAll(async () => {
  for (const id of [campusId, otherCampusId]) {
    const students = await prisma.student.findMany({
      where: { campusId: id },
      select: { id: true },
    });
    const ids = students.map((student) => student.id);
    if (ids.length > 0) {
      await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
      await prisma.studentBatchHistory.deleteMany({ where: { studentId: { in: ids } } });
      await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: ids } } });
      await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
      await prisma.student.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.squad.deleteMany({ where: { campusId: id } });
    await prisma.batch.deleteMany({ where: { campusId: id } });
    await prisma.campus.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

/** Seed the campus with a five-person roster before each test, so tests do not chain. */
beforeEach(async () => {
  const students = await prisma.student.findMany({ where: { campusId }, select: { id: true } });
  const ids = students.map((student) => student.id);
  if (ids.length > 0) {
    await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentBatchHistory.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
  }

  await importer.importRows(
    [
      row({ name: 'Stays One', leetcode: `${RUN}-stays1`, squad: 'Squad 69' }, 0),
      row({ name: 'Stays Two', leetcode: `${RUN}-stays2`, squad: 'Squad 69' }, 1),
      row({ name: 'Leaves One', leetcode: `${RUN}-leaves1`, squad: 'Squad 70' }, 2),
      row({ name: 'Leaves Two', leetcode: `${RUN}-leaves2`, squad: 'Squad 70' }, 3),
      row({ name: 'Leaves Three', leetcode: `${RUN}-leaves3`, squad: 'Squad 70' }, 4),
    ],
    { campusId, updateExisting: true },
  );
});

describe('reconciling a roster archives, and does not delete', () => {
  it('leaves exactly the supplied roster active', async () => {
    const result = await importer.importRows(
      [
        row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0),
        row({ name: 'Stays Two', leetcode: `${RUN}-stays2` }, 1),
      ],
      { campusId, updateExisting: true, archiveAbsent: true },
    );

    expect(result.created).toBe(0);
    expect(result.updated).toBe(2);
    expect(result.archived?.map((student) => student.name).sort()).toEqual([
      'Leaves One',
      'Leaves Three',
      'Leaves Two',
    ]);
    expect(await rosterOf(campusId)).toEqual(['Stays One', 'Stays Two']);
  });

  it('keeps the archived students and every submission they own', async () => {
    // The whole reason this is an archive and not a delete. A departed student's
    // submissions are what a report about a day they were present is made of; a cascade
    // delete would silently rewrite that day.
    const leaver = await active('Leaves One');
    const problem = await prisma.problem.upsert({
      where: { titleSlug: `${RUN}-two-sum` },
      create: {
        titleSlug: `${RUN}-two-sum`,
        title: 'Fixture Two Sum',
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-two-sum/`,
      },
      update: {},
    });
    await prisma.submission.create({
      data: {
        studentId: leaver!.id,
        problemId: problem.id,
        titleSlug: problem.titleSlug,
        title: problem.title,
        status: 'ACCEPTED',
        submittedAt: new Date(),
        dayKey: time.today(),
        providerSubmissionId: `${RUN}-sub-1`,
      },
    });

    await importer.importRows([row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0)], {
      campusId,
      updateExisting: true,
      archiveAbsent: true,
    });

    const after = await prisma.student.findUnique({
      where: { id: leaver!.id },
      select: { status: true, archivedAt: true, archivedReason: true },
    });
    expect(after?.status).toBe('ARCHIVED');
    expect(after?.archivedAt).toBeInstanceOf(Date);
    expect(after?.archivedReason).toBeTruthy();

    expect(await prisma.submission.count({ where: { studentId: leaver!.id } })).toBe(1);
  });

  it('does not touch another campus', async () => {
    await importer.importRows(
      [row({ name: 'Bystander', leetcode: `${RUN}-bystander` }, 0)],
      { campusId: otherCampusId, updateExisting: true },
    );

    await importer.importRows([row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0)], {
      campusId,
      updateExisting: true,
      archiveAbsent: true,
    });

    expect(await rosterOf(otherCampusId)).toEqual(['Bystander']);
  });

  it('refuses to reconcile without a campus', async () => {
    // Without a campus the complement of the roster is "every student in the system",
    // so this would archive other campuses wholesale.
    await expect(
      importer.importRows([row({ name: 'Stays One' }, 0)], { archiveAbsent: true }),
    ).rejects.toThrow(/campus/i);
  });

  it('archives nobody when a row failed, because the roster was not fully applied', async () => {
    // A student missing from `onRoster` because their row errored is indistinguishable
    // from one the roster genuinely dropped — so a partially-applied roster must not act.
    const result = await importer.importRows(
      [
        row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0),
        row({ name: '', leetcode: `${RUN}-nameless` }, 1),
      ],
      { campusId, updateExisting: true, archiveAbsent: true },
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.archived).toEqual([]);
    expect(await rosterOf(campusId)).toHaveLength(5);
  });
});

describe('reconciliation is idempotent', () => {
  it('produces the same roster twice, with no duplicates', async () => {
    const roster = [
      row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0),
      row({ name: 'Stays Two', leetcode: `${RUN}-stays2` }, 1),
    ];
    const options = { campusId, updateExisting: true, archiveAbsent: true };

    const first = await importer.importRows(roster, options);
    const second = await importer.importRows(roster, options);

    expect(first.archived).toHaveLength(3);
    // Second run has nothing left to archive — the point of idempotence.
    expect(second.archived).toHaveLength(0);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);
    expect(await rosterOf(campusId)).toEqual(['Stays One', 'Stays Two']);
    expect(await prisma.student.count({ where: { campusId } })).toBe(5);
  });

  it('brings a returning student back on their own record', async () => {
    const options = { campusId, updateExisting: true, archiveAbsent: true };
    const original = await active('Leaves One');

    await importer.importRows([row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0)], options);
    expect((await active('Leaves One'))?.status).toBe('ARCHIVED');

    await importer.importRows(
      [
        row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0),
        row({ name: 'Leaves One', leetcode: `${RUN}-leaves1` }, 1),
      ],
      options,
    );

    const returned = await active('Leaves One');
    expect(returned?.status).toBe('ACTIVE');
    // The same row, so their submissions and history come back with them rather than
    // being stranded on an archived twin.
    expect(returned?.id).toBe(original!.id);
    expect(await prisma.student.count({ where: { campusId, name: 'Leaves One' } })).toBe(1);
  });
});

describe('a blank column is silence, not an erasure', () => {
  it('keeps a LeetCode handle a later roster does not mention', async () => {
    // The Alliance case this was found in: a roster assembled before anyone collected a
    // student's handle still carries `leetcode.com/profile/` in the profile column, while
    // the student has since been linked and has a synced solve history. Writing the blank
    // through would take their sync, and every solve on it, off the dashboard.
    const before = await prisma.student.findFirst({
      where: { campusId, name: 'Stays One' },
      select: { leetcodeUsername: true },
    });
    expect(before?.leetcodeUsername).toBe(`${RUN}-stays1`.toLowerCase());

    await importer.importRows(
      [row({ name: 'Stays One', leetcode: 'https://leetcode.com/profile/' }, 0)],
      { campusId, updateExisting: true },
    );

    const after = await prisma.student.findFirst({
      where: { campusId, name: 'Stays One' },
      select: { leetcodeUsername: true },
    });
    expect(after?.leetcodeUsername).toBe(`${RUN}-stays1`.toLowerCase());
  });

  it('still replaces a handle the roster does supply', async () => {
    await importer.importRows(
      [row({ name: 'Stays One', leetcode: `https://leetcode.com/u/${RUN}-corrected/` }, 0)],
      { campusId, updateExisting: true },
    );

    const after = await prisma.student.findFirst({
      where: { campusId, name: 'Stays One' },
      select: { leetcodeUsername: true },
    });
    expect(after?.leetcodeUsername).toBe(`${RUN}-corrected`.toLowerCase());
  });
});

describe('a dry run reports the reconciliation without performing it', () => {
  it('names who would be archived and writes nothing', async () => {
    const result = await importer.importRows(
      [
        row({ name: 'Stays One', leetcode: `${RUN}-stays1` }, 0),
        row({ name: 'Brand New', leetcode: `${RUN}-new` }, 1),
      ],
      { campusId, updateExisting: true, archiveAbsent: true, dryRun: true },
    );

    // The numbers a dry run is run to see: which rows already exist, which are new, and
    // who the roster would remove — all resolved by the same code the real run uses.
    expect(result.updated).toBe(1);
    expect(result.created).toBe(1);
    expect(result.archived?.map((student) => student.name).sort()).toEqual([
      'Leaves One',
      'Leaves Three',
      'Leaves Two',
      'Stays Two',
    ]);

    // …and nothing changed.
    expect(await rosterOf(campusId)).toEqual([
      'Leaves One',
      'Leaves Three',
      'Leaves Two',
      'Stays One',
      'Stays Two',
    ]);
    expect(await prisma.student.count({ where: { campusId, name: 'Brand New' } })).toBe(0);
  });
});
