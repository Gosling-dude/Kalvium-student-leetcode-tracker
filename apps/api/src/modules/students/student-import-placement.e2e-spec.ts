/**
 * Spreadsheet import must record placement history, verified against a real database.
 *
 * The bug this pins down: the importer set `students."batchId"` directly and never wrote
 * a `StudentBatchHistory` row. Nothing looks wrong on the student record — but every
 * historical query reads the history table, and `batchOnDayForStudents` has no fallback to
 * `Student.batchId` (deliberately: falling back would re-file already-closed days under a
 * batch the student joined later). So a student onboarded by spreadsheet resolved to "no
 * batch on any day", which meant `selectAssignmentForScope` never matched a batch-targeted
 * assignment for them and their `DailyStatus` rows carried a null batch.
 *
 * That is the exact path 250 students are about to be onboarded through, so it is verified
 * end to end through the real service against real Postgres rather than a mocked Prisma —
 * the thing under test *is* what got written to the database.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBatchOnDay, resolveCampusOnDay, selectAssignmentForScope } from '@dsa/shared';

import { StudentImportService } from './student-import.service';
import { BatchesService } from '../batches/batches.service';
import { ProgramTimeService } from '../../common/services/program-time.service';

const prisma = new PrismaClient();

const RUN = `e2e-import-${Date.now()}`;
const email = (name: string): string => `${RUN}-${name}@import-placement.invalid`;

/** The real services, wired by hand — no Nest container needed for three constructors. */
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
let batchAId: string;
let batchBId: string;

/** Build the workbook the importer actually parses, rather than stubbing the parser. */
async function sheet(
  rows: { name: string; email: string; leetcode: string; batch?: string; squad?: string }[],
  options: { includeBatchColumn?: boolean } = {},
): Promise<Buffer> {
  const includeBatch = options.includeBatchColumn ?? true;
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet('Students');
  ws.addRow(
    includeBatch
      ? ['Name', 'Email', 'LeetCode Username', 'Batch', 'Squad']
      : ['Name', 'Email', 'LeetCode Username'],
  );
  for (const row of rows) {
    ws.addRow(
      includeBatch
        ? [row.name, row.email, row.leetcode, row.batch ?? '', row.squad ?? '']
        : [row.name, row.email, row.leetcode],
    );
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

beforeAll(async () => {
  const campus = await prisma.campus.findUnique({ where: { code: 'VELS' } });
  if (!campus) {
    throw new Error(
      'Campus VELS is missing. Run `npm run db:migrate -w @dsa/api` before the e2e suite.',
    );
  }
  campusId = campus.id;

  const a = await prisma.batch.findUnique({ where: { campusId_code: { campusId, code: 'A' } } });
  const b = await prisma.batch.findUnique({ where: { campusId_code: { campusId, code: 'B' } } });
  if (!a || !b) {
    throw new Error('Batches A and B are missing. Run the migrations before the e2e suite.');
  }
  batchAId = a.id;
  batchBId = b.id;
});

afterAll(async () => {
  const students = await prisma.student.findMany({
    where: { email: { startsWith: RUN } },
    select: { id: true },
  });
  const ids = students.map((s) => s.id);
  if (ids.length > 0) {
    await prisma.studentBatchHistory.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentCampusHistory.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe('spreadsheet import — placement history', () => {
  it('records a batch placement for a newly imported student', async () => {
    const address = email('fresh');
    const result = await importer.import(
      await sheet([
        { name: 'Fresh Import', email: address, leetcode: `${RUN}-fresh`, batch: 'A' },
      ]),
      { campusId, updateExisting: true },
    );
    expect(result.created).toBe(1);

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: true, campusHistory: true },
    });
    expect(student?.batchId).toBe(batchAId);

    // The record on the student is not the point — the history row is, because that is
    // what every historical query actually reads.
    expect(student?.batchHistory).toHaveLength(1);
    expect(student?.batchHistory[0]?.toBatchId).toBe(batchAId);
    expect(student?.campusHistory).toHaveLength(1);
    expect(student?.campusHistory[0]?.toCampusId).toBe(campusId);
  });

  it('resolves the imported student into their batch on the day they were imported', async () => {
    const address = email('resolves');
    await importer.import(
      await sheet([
        { name: 'Resolves', email: address, leetcode: `${RUN}-resolves`, batch: 'A' },
      ]),
      { campusId, updateExisting: true },
    );

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: true, campusHistory: true },
    });
    const today = time.today();

    // The regression in one assertion: before the fix this returned null, and a null batch
    // is what dropped imported students out of every batch-targeted assignment.
    expect(resolveBatchOnDay(student!.batchHistory, today)).toBe(batchAId);
    expect(resolveCampusOnDay(student!.campusHistory, today)).toBe(campusId);
  });

  it('selects a batch-targeted assignment for an imported student', async () => {
    const address = email('targeted');
    await importer.import(
      await sheet([
        { name: 'Targeted', email: address, leetcode: `${RUN}-targeted`, batch: 'A' },
      ]),
      { campusId, updateExisting: true },
    );

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: true },
    });
    const today = time.today();
    const batchOnDay = resolveBatchOnDay(student!.batchHistory, today);

    const forBatchA = { id: 'assignment-a', campusId, batchId: batchAId };
    const forBatchB = { id: 'assignment-b', campusId, batchId: batchBId };

    const chosen = selectAssignmentForScope([forBatchA, forBatchB], {
      campusId,
      batchId: batchOnDay,
    });
    expect(chosen?.id).toBe('assignment-a');
  });

  it('records a placement change when a re-import moves the student to another batch', async () => {
    const address = email('moved');
    const rows = { name: 'Moved', email: address, leetcode: `${RUN}-moved` };

    await importer.import(await sheet([{ ...rows, batch: 'A' }]), {
      campusId,
      updateExisting: true,
    });
    await importer.import(await sheet([{ ...rows, batch: 'B' }]), {
      campusId,
      updateExisting: true,
    });

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: { orderBy: { changedAt: 'asc' } } },
    });

    expect(student?.batchId).toBe(batchBId);
    expect(student?.batchHistory).toHaveLength(2);
    expect(student?.batchHistory[1]?.fromBatchId).toBe(batchAId);
    expect(student?.batchHistory[1]?.toBatchId).toBe(batchBId);
  });

  it('does not write a placement row when a re-import changes nothing', async () => {
    const address = email('unchanged');
    const rows = { name: 'Unchanged', email: address, leetcode: `${RUN}-unchanged`, batch: 'A' };

    await importer.import(await sheet([rows]), { campusId, updateExisting: true });
    await importer.import(await sheet([rows]), { campusId, updateExisting: true });
    await importer.import(await sheet([rows]), { campusId, updateExisting: true });

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: true },
    });

    // A no-op re-import must not litter the history: every extra row competes to answer
    // "where was this student on day D".
    expect(student?.batchHistory).toHaveLength(1);
  });

  it('does not unassign a batch when the sheet omits the Batch column', async () => {
    const address = email('nobatchcol');

    await importer.import(
      await sheet([
        { name: 'Keeps Batch', email: address, leetcode: `${RUN}-nobatchcol`, batch: 'A' },
      ]),
      { campusId, updateExisting: true },
    );

    // A sheet without a Batch column says nothing about placement — it does not say
    // "remove them from their batch".
    await importer.import(
      await sheet([{ name: 'Keeps Batch', email: address, leetcode: `${RUN}-nobatchcol` }], {
        includeBatchColumn: false,
      }),
      { campusId, updateExisting: true },
    );

    const student = await prisma.student.findUnique({
      where: { email: address },
      include: { batchHistory: true },
    });

    expect(student?.batchId).toBe(batchAId);
    expect(student?.batchHistory).toHaveLength(1);
  });
});
