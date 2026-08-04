/**
 * Excel/CSV student import.
 *
 * At 250+ students a spreadsheet is never entirely clean. The import is therefore
 * built around *partial success*: valid rows are created, invalid rows are reported
 * individually with their row number and the offending field, and the whole thing
 * never fails as a single opaque 400. A mentor needs to know that row 47 has a
 * duplicate email — not that "the upload failed".
 *
 * Batches and groups referenced by the sheet are created on demand, because requiring
 * them to exist first makes the very first import impossible.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { IMPORT_COLUMN_ALIASES, type ImportResult, type ImportRowError } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';

interface ParsedRow {
  rowNumber: number;
  name: string;
  email: string;
  batch: string | null;
  group: string | null;
  leetcodeUsername: string;
  phone: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** LeetCode handles: letters, digits, underscore and hyphen, 1–39 characters. */
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,39}$/;

@Injectable()
export class StudentImportService {
  private readonly logger = new Logger(StudentImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async import(
    buffer: Buffer,
    options: { dryRun?: boolean; updateExisting?: boolean } = {},
  ): Promise<ImportResult> {
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
        createdGroups: [],
      };
    }

    const { batchIds, createdBatches } = await this.ensureBatches(valid);
    const { groupIds, createdGroups } = await this.ensureGroups(valid, batchIds);

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of valid) {
      const batchId = row.batch ? (batchIds.get(row.batch.toLowerCase()) ?? null) : null;
      const groupKey = this.groupKey(row.batch, row.group);
      const groupId = row.group ? (groupIds.get(groupKey) ?? null) : null;

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

          await this.prisma.student.update({
            where: { id: existing.id },
            data: {
              name: row.name,
              email: row.email,
              phone: row.phone,
              leetcodeUsername: row.leetcodeUsername.toLowerCase(),
              batchId,
              groupId,
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
              batchId,
              groupId,
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
      createdGroups,
    };
  }

  /** Build a template workbook so mentors start from the exact expected columns. */
  async buildTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Students');

    sheet.columns = [
      { header: 'Name', key: 'name', width: 28 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Batch', key: 'batch', width: 18 },
      { header: 'Group', key: 'group', width: 18 },
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
      group: 'Group 1',
      leetcodeUsername: 'asha_menon',
      phone: '9876543210',
    });

    const notes = workbook.addWorksheet('Instructions');
    notes.getColumn(1).width = 100;
    notes.addRows([
      ['Only Name, Email and LeetCode Username are required.'],
      ['Batch and Group are created automatically if they do not already exist.'],
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
          `Expected headers: Name, Email, Batch, Group, LeetCode Username, Phone.`,
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
        group: read('group') || null,
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

  private async ensureBatches(
    rows: ParsedRow[],
  ): Promise<{ batchIds: Map<string, string>; createdBatches: string[] }> {
    const names = [...new Set(rows.map((r) => r.batch).filter((n): n is string => !!n))];
    const batchIds = new Map<string, string>();
    const createdBatches: string[] = [];

    for (const name of names) {
      const existing = await this.prisma.batch.findUnique({ where: { name } });
      if (existing) {
        batchIds.set(name.toLowerCase(), existing.id);
      } else {
        const batch = await this.prisma.batch.create({ data: { name } });
        batchIds.set(name.toLowerCase(), batch.id);
        createdBatches.push(name);
      }
    }

    return { batchIds, createdBatches };
  }

  private async ensureGroups(
    rows: ParsedRow[],
    batchIds: Map<string, string>,
  ): Promise<{ groupIds: Map<string, string>; createdGroups: string[] }> {
    const groupIds = new Map<string, string>();
    const createdGroups: string[] = [];

    const pairs = new Map<string, { batch: string | null; group: string }>();
    for (const row of rows) {
      if (!row.group) continue;
      pairs.set(this.groupKey(row.batch, row.group), { batch: row.batch, group: row.group });
    }

    for (const [key, pair] of pairs) {
      const batchId = pair.batch ? (batchIds.get(pair.batch.toLowerCase()) ?? null) : null;

      const existing = await this.prisma.group.findFirst({
        where: { name: pair.group, batchId },
      });

      if (existing) {
        groupIds.set(key, existing.id);
      } else {
        const group = await this.prisma.group.create({
          data: { name: pair.group, batchId },
        });
        groupIds.set(key, group.id);
        createdGroups.push(pair.batch ? `${pair.batch} / ${pair.group}` : pair.group);
      }
    }

    return { groupIds, createdGroups };
  }

  /** Group names are unique per batch, so the cache key must include the batch. */
  private groupKey(batch: string | null, group: string | null): string {
    return `${(batch ?? '').toLowerCase()}::${(group ?? '').toLowerCase()}`;
  }
}
