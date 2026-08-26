/**
 * Excel/CSV student import.
 *
 * At 250+ students a spreadsheet is never entirely clean. The import is therefore
 * built around *partial success*: valid rows are created, invalid rows are reported
 * individually with their row number and the offending field, and the whole thing
 * never fails as a single opaque 400. A mentor needs to know that row 47 has a
 * duplicate email — not that "the upload failed".
 *
 * Batches and squads referenced by the sheet are created on demand, because requiring
 * them to exist first makes the very first import impossible.
 *
 * Every import lands at exactly one campus, named by the caller. It is not inferred from
 * the sheet and not defaulted to the founding campus: batches and squads are campus-scoped
 * now, so a wrong guess would create a second "Foundation Level" under the wrong campus
 * and quietly file a whole cohort where no mentor is looking for them. The one case where
 * omitting it is safe — a single campus exists, so there is nothing to guess between — is
 * resolved explicitly below.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import {
  IMPORT_COLUMN_ALIASES,
  normaliseBatchCode,
  resolvePlacementEffectiveDate,
  type ImportResult,
  type ImportRowError,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { BatchesService } from '../batches/batches.service';

interface ParsedRow {
  rowNumber: number;
  name: string;
  email: string;
  batch: string | null;
  squad: string | null;
  leetcodeUsername: string;
  phone: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** LeetCode handles: letters, digits, underscore and hyphen, 1–39 characters. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

@Injectable()
export class StudentImportService {
  private readonly logger = new Logger(StudentImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BatchesService,
    private readonly time: ProgramTimeService,
  ) {}

  async import(
    buffer: Buffer,
    options: { dryRun?: boolean; updateExisting?: boolean; campusId?: string } = {},
  ): Promise<ImportResult> {
    const campusId = await this.resolveImportCampus(options.campusId);
    const rows = await this.parseWorkbook(buffer);
    const errors: ImportRowError[] = [];
    const valid: ParsedRow[] = [];

    // Duplicates *within the sheet* are caught here; duplicates against the database
    // are caught per row below. Both are common and need distinct messages.
    const seenEmails = new Map<string, number>();
    const seenUsernames = new Map<string, number>();

    for (const row of rows) {
      const rowErrors = this.validateRow(row);

      const priorEmail = seenEmails.get(row.email);
      if (priorEmail !== undefined) {
        rowErrors.push({
          row: row.rowNumber,
          field: 'email',
          message: `Duplicate of row ${priorEmail} in this file`,
          data: { email: row.email },
        });
      }

      const priorUsername = seenUsernames.get(row.leetcodeUsername.toLowerCase());
      if (priorUsername !== undefined) {
        rowErrors.push({
          row: row.rowNumber,
          field: 'leetcodeUsername',
          message: `Duplicate of row ${priorUsername} in this file`,
          data: { leetcodeUsername: row.leetcodeUsername },
        });
      }

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      seenEmails.set(row.email, row.rowNumber);
      seenUsernames.set(row.leetcodeUsername.toLowerCase(), row.rowNumber);
      valid.push(row);
    }

    if (options.dryRun) {
      return {
        totalRows: rows.length,
        created: 0,
        updated: 0,
        skipped: valid.length,
        errors,
        createdBatches: [],
        createdSquads: [],
      };
    }

    const { batchIds, createdBatches } = await this.ensureBatches(valid, campusId);
    const { squadIds, createdSquads } = await this.ensureSquads(valid, batchIds, campusId);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of valid) {
      const batchId = row.batch ? (batchIds.get(row.batch.toLowerCase()) ?? null) : null;
      const squadKey = this.squadKey(row.batch, row.squad);
      const squadId = row.squad ? (squadIds.get(squadKey) ?? null) : null;

      try {
        const existing = await this.prisma.student.findFirst({
          where: {
            OR: [
              { email: row.email },
              { leetcodeUsername: row.leetcodeUsername.toLowerCase() },
            ],
          },
        });

        if (existing) {
          if (!options.updateExisting) {
            skipped += 1;
            errors.push({
              row: row.rowNumber,
              field: existing.email === row.email ? 'email' : 'leetcodeUsername',
              message:
                'Student already exists. Re-run with "update existing" to overwrite their details.',
              data: { email: row.email, leetcodeUsername: row.leetcodeUsername },
            });
            continue;
          }

          // A re-import that changes someone's campus or batch is a placement change, and
          // it has to leave the same history trail as every other route that moves a
          // student. Without it `Student.batchId` says one thing and
          // `StudentBatchHistory` says nothing at all — and every historical query reads
          // the history, so the student resolves to "no batch on any day", drops out of
          // batch-targeted assignments and lands on reports with a null batch (§7, §17).
          const placement = await this.placementWrites({
            studentId: existing.id,
            enrolledAt: existing.createdAt,
            fromCampusId: existing.campusId,
            toCampusId: campusId,
            fromBatchId: existing.batchId,
            toBatchId: batchId,
          });

          await this.prisma.student.update({
            where: { id: existing.id },
            data: {
              name: row.name,
              email: row.email,
              phone: row.phone,
              leetcodeUsername: row.leetcodeUsername.toLowerCase(),
              campusId,
              // A sheet without a Batch/Squad column says nothing about placement — it
              // does not say "remove them". Writing the null through would unassign the
              // whole cohort on any re-import that omits those columns, which is exactly
              // the kind of silent, roster-wide edit an import must never make.
              ...(batchId !== null ? { batchId } : {}),
              ...(squadId !== null ? { squadId } : {}),
              ...placement,
            },
          });
          updated += 1;
        } else {
          await this.prisma.student.create({
            data: {
              name: row.name,
              email: row.email,
              phone: row.phone,
              leetcodeUsername: row.leetcodeUsername.toLowerCase(),
              campusId,
              batchId,
              squadId,
              // Placement history from day one, so a report about today can resolve this
              // student's campus without falling back to their current one (§17).
              campusHistory: {
                create: {
                  toCampusId: campusId,
                  effectiveFromDayKey: this.time.today(),
                  source: 'IMPORT' as const,
                  reason: 'Spreadsheet import',
                },
              },
              // The batch needs the same trail as the campus. It was missing here, which
              // meant every student onboarded by spreadsheet had a `batchId` that no
              // historical query could see: `batchOnDayForStudents` reads this table and
              // has no fallback to `Student.batchId` — deliberately, because falling back
              // would re-file closed days under a batch joined later. The consequence was
              // that batch-targeted assignments never selected for imported students.
              ...(batchId
                ? {
                    batchHistory: {
                      create: {
                        toBatchId: batchId,
                        effectiveFromDayKey: this.time.today(),
                        source: 'IMPORT' as const,
                        reason: 'Initial placement from spreadsheet import',
                      },
                    },
                  }
                : {}),
              // A student who has never been synced must not be reported as
              // "solved 0" — they have no data yet, which is a different thing.
              syncState: { create: { status: 'NEVER_SYNCED' } },
            },
          });
          created += 1;
        }
      } catch (error) {
        errors.push({
          row: row.rowNumber,
          field: null,
          message: `Could not save: ${(error as Error).message}`,
          data: { email: row.email },
        });
      }
    }

    this.logger.log(
      `Import complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors.length} errors`,
    );

    return {
      totalRows: rows.length,
      created,
      updated,
      skipped,
      errors,
      createdBatches,
      createdSquads,
    };
  }

  /**
   * The nested `campusHistory`/`batchHistory` writes a re-import needs, if any.
   *
   * Returns `{}` when nothing moved, so an import that only corrects a spelling does not
   * litter the placement history with no-op rows — the history is read as "where was this
   * student on day D", and a row that changes nothing still competes for that answer.
   *
   * Which day a move takes effect from is `resolvePlacementEffectiveDate`, the same rule
   * the roster sync uses: a *first* recorded placement is back-dated to enrolment (the
   * sheet is stating what has been true all along), while a genuine move is effective
   * today so that already-closed days keep the batch they were completed under (§7).
   */
  private async placementWrites(input: {
    studentId: string;
    enrolledAt: Date;
    fromCampusId: string | null;
    toCampusId: string;
    fromBatchId: string | null;
    toBatchId: string | null;
  }): Promise<Prisma.StudentUncheckedUpdateInput> {
    const writes: Prisma.StudentUncheckedUpdateInput = {};
    const todayDayKey = this.time.today();
    const enrolmentDayKey = this.time.dayKeyOf(input.enrolledAt);

    if (input.fromCampusId !== input.toCampusId) {
      const priorCampusPlacements = await this.prisma.studentCampusHistory.count({
        where: { studentId: input.studentId },
      });
      writes.campusHistory = {
        create: {
          fromCampusId: input.fromCampusId,
          toCampusId: input.toCampusId,
          effectiveFromDayKey: resolvePlacementEffectiveDate({
            hasPriorPlacements: priorCampusPlacements > 0,
            todayDayKey,
            enrolmentDayKey,
          }),
          source: 'IMPORT',
          reason: 'Campus changed by spreadsheet import',
        },
      };
    }

    // A sheet with no Batch column leaves `toBatchId` null. That is "the sheet did not
    // say", not "move this student out of their batch", so it is never treated as a move.
    if (input.toBatchId !== null && input.fromBatchId !== input.toBatchId) {
      const priorBatchPlacements = await this.prisma.studentBatchHistory.count({
        where: { studentId: input.studentId },
      });
      writes.batchHistory = {
        create: {
          fromBatchId: input.fromBatchId,
          toBatchId: input.toBatchId,
          effectiveFromDayKey: resolvePlacementEffectiveDate({
            hasPriorPlacements: priorBatchPlacements > 0,
            todayDayKey,
            enrolmentDayKey,
          }),
          source: 'IMPORT',
          reason: 'Batch changed by spreadsheet import',
        },
      };
    }

    return writes;
  }

  /** Build a template workbook so mentors start from the exact expected columns. */
  async buildTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Students');

    sheet.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Batch', key: 'batch', width: 18 },
      { header: 'Squad', key: 'squad', width: 18 },
      { header: 'LeetCode Username', key: 'leetcodeUsername', width: 26 },
      { header: 'Phone', key: 'phone', width: 18 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E293B' },
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    sheet.addRow({
      name: 'Asha Menon',
      email: 'asha.menon@kalvium.com',
      batch: 'Batch 2026',
      squad: 'Squad 1',
      leetcodeUsername: 'asha_menon',
      phone: '9876543210',
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.getColumn(1).width = 100;
    notes.addRows([
      ['Only Name, Email and LeetCode Username are required.'],
      ['Batch and Squad are created automatically if they do not already exist.'],
      ['Phone is optional.'],
      ['The LeetCode username must match the profile URL exactly: leetcode.com/u/<username>.'],
      ['A wrong username makes a student appear to have solved nothing, so double-check them.'],
      ['Rows with problems are reported individually — the rest of the file still imports.'],
    ]);

    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }

  // -------------------------------------------------------------------------

  private async parseWorkbook(buffer: Buffer): Promise<ParsedRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException(
        'Could not read the file. Upload a .xlsx workbook exported from Excel or Google Sheets.',
      );
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('The workbook contains no sheets.');

    const headerRow = sheet.getRow(1);
    const columnMap = this.mapColumns(headerRow);

    const missing = (['name', 'email', 'leetcodeUsername'] as const).filter(
      (field) => columnMap[field] === undefined,
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `The sheet is missing required column(s): ${missing.join(', ')}. ` +
          `Expected headers: Name, Email, Batch, Squad, LeetCode Username, Phone.`,
      );
    }

    const rows: ParsedRow[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const read = (field: string): string => {
        const index = columnMap[field];
        if (index === undefined) return '';
        return this.cellToString(row.getCell(index).value);
      };

      const name = read('name');
      const email = read('email');
      const username = read('leetcodeUsername');

      // Skip entirely blank rows — trailing empties are ubiquitous in real sheets
      // and reporting them as errors would bury the genuine ones.
      if (!name && !email && !username) return;

      rows.push({
        rowNumber,
        name,
        email: email.toLowerCase(),
        batch: read('batch') || null,
        squad: read('squad') || null,
        leetcodeUsername: this.normaliseUsername(username),
        phone: read('phone') || null,
      });
    });

    return rows;
  }

  private mapColumns(headerRow: ExcelJS.Row): Record<string, number | undefined> {
    const map: Record<string, number | undefined> = {};

    headerRow.eachCell((cell, colNumber) => {
      const normalised = this.cellToString(cell.value)
        .toLowerCase()
        .replace(/[\s_\-.]/g, '');
      if (!normalised) return;

      for (const [field, aliases] of Object.entries(IMPORT_COLUMN_ALIASES)) {
        if (map[field] === undefined && aliases.includes(normalised)) {
          map[field] = colNumber;
          return;
        }
      }
    });

    return map;
  }

  /** Excel cells can hold formulas, rich text, hyperlinks or dates — all become strings. */
  private cellToString(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
      if ('text' in value && typeof value.text === 'string') return value.text.trim();
      if ('result' in value) return this.cellToString(value.result as ExcelJS.CellValue);
      if ('richText' in value && Array.isArray(value.richText)) {
        return value.richText.map((part) => part.text).join('').trim();
      }
      if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.hyperlink.trim();
    }
    return String(value).trim();
  }

  /**
   * Mentors routinely paste a whole profile URL into the username column.
   * Accepting that is cheaper than rejecting it — a rejected row means a student
   * silently missing from every report.
   */
  private normaliseUsername(raw: string): string {
    const trimmed = raw.trim();
    const urlMatch = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(trimmed);
    if (urlMatch?.[1]) return urlMatch[1];
    return trimmed.replace(/^@/, '');
  }

  private validateRow(row: ParsedRow): ImportRowError[] {
    const errors: ImportRowError[] = [];
    const data = { name: row.name, email: row.email, leetcodeUsername: row.leetcodeUsername };

    if (!row.name) {
      errors.push({ row: row.rowNumber, field: 'name', message: 'Name is required', data });
    }
    if (!row.email) {
      errors.push({ row: row.rowNumber, field: 'email', message: 'Email is required', data });
    } else if (!EMAIL_PATTERN.test(row.email)) {
      errors.push({
        row: row.rowNumber,
        field: 'email',
        message: `"${row.email}" is not a valid email address`,
        data,
      });
    }
    if (!row.leetcodeUsername) {
      errors.push({
        row: row.rowNumber,
        field: 'leetcodeUsername',
        message: 'LeetCode username is required',
        data,
      });
    } else if (!USERNAME_PATTERN.test(row.leetcodeUsername)) {
      errors.push({
        row: row.rowNumber,
        field: 'leetcodeUsername',
        message:
          `"${row.leetcodeUsername}" is not a valid LeetCode username ` +
          '(letters, digits, underscore and hyphen only)',
        data,
      });
    }

    return errors;
  }

  /**
   * Which campus this import targets.
   *
   * Named by the caller, or inferred only when there is exactly one campus and therefore
   * nothing to infer between. With two or more, refusing is the right answer: silently
   * choosing one files a whole cohort under a campus nobody asked for, and the mistake is
   * only visible once a mentor wonders why their new students are missing.
   */
  private async resolveImportCampus(campusId?: string): Promise<string> {
    if (campusId) {
      const campus = await this.prisma.campus.findUnique({
        where: { id: campusId },
        select: { id: true, status: true, name: true },
      });
      if (!campus) throw new BadRequestException(`Campus ${campusId} was not found.`);
      if (campus.status !== 'ACTIVE') {
        throw new BadRequestException(`${campus.name} is archived and cannot receive an import.`);
      }
      return campus.id;
    }

    const campuses = await this.prisma.campus.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true },
    });
    if (campuses.length === 1 && campuses[0]) return campuses[0].id;
    if (campuses.length === 0) {
      throw new BadRequestException('No active campus exists to import into. Create one first.');
    }
    throw new BadRequestException(
      `Several campuses exist (${campuses.map((c) => c.code).join(', ')}). ` +
        'Choose which one these students belong to before importing.',
    );
  }

  private async ensureBatches(
    rows: ParsedRow[],
    campusId: string,
  ): Promise<{ batchIds: Map<string, string>; createdBatches: string[] }> {
    const names = [...new Set(rows.map((r) => r.batch).filter((n): n is string => !!n))];
    const batchIds = new Map<string, string>();
    const createdBatches: string[] = [];

    for (const name of names) {
      // Scoped to the campus: an "Intermediate Level" at Vels must not silently absorb
      // an "Intermediate Level" row meant for SRM.
      //
      // Matched on name *or* code, because both identify a batch and a spreadsheet column
      // headed "Batch" is filled in with whichever one the person typing knows. Matching
      // on name alone created a second batch literally named "A" next to the existing
      // batch whose code is "A" — same cohort, two rows, and from then on half the
      // students are targeted by an assignment and half are not.
      const existing =
        (await this.prisma.batch.findUnique({
          where: { campusId_name: { campusId, name } },
        })) ??
        (await this.prisma.batch.findUnique({
          where: { campusId_code: { campusId, code: normaliseBatchCode(name) } },
        }));
      if (existing) {
        batchIds.set(name.toLowerCase(), existing.id);
      } else {
        // `code` is required and unique per campus; derive one from the name for
        // spreadsheet imports, which only carry a batch name.
        const batch = await this.prisma.batch.create({
          data: { campusId, name, code: await this.batches.deriveAvailableCode(name, campusId) },
        });
        batchIds.set(name.toLowerCase(), batch.id);
        createdBatches.push(name);
      }
    }

    return { batchIds, createdBatches };
  }

  private async ensureSquads(
    rows: ParsedRow[],
    batchIds: Map<string, string>,
    campusId: string,
  ): Promise<{ squadIds: Map<string, string>; createdSquads: string[] }> {
    const squadIds = new Map<string, string>();
    const createdSquads: string[] = [];

    const pairs = new Map<string, { batch: string | null; squad: string }>();
    for (const row of rows) {
      if (!row.squad) continue;
      pairs.set(this.squadKey(row.batch, row.squad), { batch: row.batch, squad: row.squad });
    }

    for (const [key, pair] of pairs) {
      const batchId = pair.batch ? (batchIds.get(pair.batch.toLowerCase()) ?? null) : null;

      const existing = await this.prisma.squad.findFirst({
        where: { name: pair.squad, batchId, campusId },
      });

      if (existing) {
        squadIds.set(key, existing.id);
      } else {
        const squad = await this.prisma.squad.create({
          data: { name: pair.squad, batchId, campusId },
        });
        squadIds.set(key, squad.id);
        createdSquads.push(pair.batch ? `${pair.batch} / ${pair.squad}` : pair.squad);
      }
    }

    return { squadIds, createdSquads };
  }

  /** Squad names are unique per batch, so the cache key must include the batch. */
  private squadKey(batch: string | null, squad: string | null): string {
    return `${(batch ?? '').toLowerCase()}::${(squad ?? '').toLowerCase()}`;
  }
}
