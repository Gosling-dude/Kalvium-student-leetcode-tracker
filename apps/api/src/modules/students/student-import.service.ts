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
  normaliseSquadNumber,
  resolveLeetcodeProfile,
  squadName,
  resolvePlacementEffectiveDate,
  type ArchivedStudent,
  type ImportResult,
  type ImportRowError,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { BatchesService } from '../batches/batches.service';

export interface ParsedRow {
  rowNumber: number;
  name: string;
  email: string;
  batch: string | null;
  squad: string | null;
  leetcodeUsername: string;
  /** Exactly what the sheet held, before any handle extraction — used in error messages. */
  rawLeetcode: string | null;
  /** Institutional register/roll number, when the sheet carries one. */
  registerNumber: string | null;
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
    return this.importRows(await this.parseWorkbook(buffer), options);
  }

  /**
   * Import already-parsed rows.
   *
   * Split out from `import` so a roster can arrive as something other than a spreadsheet —
   * the internal roster endpoint takes JSON — without either path growing its own copy of
   * the validation, de-duplication and placement rules. The workbook parser is now the
   * only thing `import` adds.
   */
  async importRows(
    rows: ParsedRow[],
    options: {
      dryRun?: boolean;
      updateExisting?: boolean;
      campusId?: string;
      /**
       * Treat the roster as the *complete* list for this campus: every ACTIVE student in
       * it that the roster does not mention is archived.
       *
       * Off by default, and deliberately so. An ordinary import is additive — a sheet of
       * twelve new joiners says nothing about the other two hundred students, and reading
       * it as "archive everyone else" would empty a campus from a partial upload. Only a
       * caller that knows it holds the whole roster may ask for this.
       *
       * Requires `campusId`: reconciling against "every student everywhere" would archive
       * other campuses' students, which is never what a campus roster means.
       */
      archiveAbsent?: boolean;
      /** Recorded on each archived student, so "why is this person inactive" has an answer. */
      archiveReason?: string;
    } = {},
  ): Promise<ImportResult> {
    const campusId = await this.resolveImportCampus(options.campusId);
    const errors: ImportRowError[] = [];
    const warnings: ImportRowError[] = [];
    const valid: ParsedRow[] = [];

    // Duplicates *within the sheet* are caught here; duplicates against the database
    // are caught per row below. Both are common and need distinct messages.
    const seenEmails = new Map<string, number>();
    const seenUsernames = new Map<string, number>();

    for (const row of rows) {
      const { errors: rowErrors, warnings: rowWarnings } = this.validateRow(row);
      warnings.push(...rowWarnings);

      // Only a *supplied* value can duplicate. Several rows legitimately share "no email"
      // and "no handle", and treating those absences as collisions would reject everyone
      // after the first.
      if (row.email) {
        const priorEmail = seenEmails.get(row.email);
        if (priorEmail !== undefined) {
          rowErrors.push({
            row: row.rowNumber,
            field: 'email',
            message: `Duplicate of row ${priorEmail} in this file`,
            data: { email: row.email },
          });
        }
      }

      if (row.leetcodeUsername) {
        const priorUsername = seenUsernames.get(row.leetcodeUsername.toLowerCase());
        if (priorUsername !== undefined) {
          rowErrors.push({
            row: row.rowNumber,
            field: 'leetcodeUsername',
            message: `Duplicate of row ${priorUsername} in this file`,
            data: { leetcodeUsername: row.leetcodeUsername },
          });
        }
      }

      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }

      if (row.email) seenEmails.set(row.email, row.rowNumber);
      if (row.leetcodeUsername) {
        seenUsernames.set(row.leetcodeUsername.toLowerCase(), row.rowNumber);
      }
      valid.push(row);
    }

    if (options.archiveAbsent && !campusId) {
      throw new BadRequestException(
        'archiveAbsent needs a campus. Reconciling against every student in the system ' +
          'would archive other campuses’ students, which a campus roster never means.',
      );
    }

    if (options.dryRun) {
      // Resolve identity for real, then write nothing. This used to report
      // `skipped: valid.length` and no more, which answered "how many rows parsed" —
      // while the thing a dry run is run to find out is *which of them already exist*.
      // Every query below is a read, so the promise that a dry run changes nothing is
      // unaffected, and the numbers now mean the same as the ones the real run reports
      // because they come from the same `findExisting`.
      const matched = new Set<string>();
      let wouldCreate = 0;
      for (const row of valid) {
        const existing = await this.findExisting(row, campusId);
        if (existing) matched.add(existing.id);
        else wouldCreate += 1;
      }

      return {
        totalRows: rows.length,
        created: wouldCreate,
        updated: matched.size,
        skipped: 0,
        errors,
        warnings,
        createdBatches: [],
        createdSquads: [],
        ...(options.archiveAbsent
          ? { archived: await this.absentFromRoster(campusId!, matched) }
          : {}),
      };
    }

    const { batchIds, createdBatches } = await this.ensureBatches(valid, campusId);
    const { squadIds, createdSquads } = await this.ensureSquads(valid, batchIds, campusId);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    /**
     * Every student this roster accounted for, whether it created them or matched them.
     * `archiveAbsent` is the complement of this set — so a student the roster *did*
     * name can never be archived by the same run, however they were matched.
     */
    const onRoster = new Set<string>();

    for (const row of valid) {
      const batchId = row.batch ? (batchIds.get(row.batch.toLowerCase()) ?? null) : null;
      const squadKey = this.squadKey(row.batch, row.squad);
      const squadId = row.squad ? (squadIds.get(squadKey) ?? null) : null;

      try {
        const existing = await this.findExisting(row, campusId);

        if (existing) {
          onRoster.add(existing.id);
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
              // A blank cell is silence, not an instruction — the same rule the batch and
              // squad columns follow below, and for the same reason.
              //
              // These three used to write their nulls through, which made a re-import
              // *destructive*: a roster assembled before anyone collected a student's
              // LeetCode handle would erase the handle that had been collected since,
              // taking their sync and their whole solved history off the dashboard with
              // it. That is not hypothetical — Alliance's BHUVANA SHRI was carrying a
              // working handle and 20 mirrored submissions against a roster row whose
              // profile column still read `leetcode.com/profile/`.
              //
              // Clearing a handle or an address is a real thing to want, but it is a
              // deliberate single-student edit through the directory, not something a
              // bulk upload should do to a cohort as a side effect of a column nobody
              // filled in.
              ...(row.email ? { email: row.email } : {}),
              ...(row.registerNumber ? { registerNumber: row.registerNumber } : {}),
              ...(row.phone ? { phone: row.phone } : {}),
              ...(row.leetcodeUsername
                ? { leetcodeUsername: row.leetcodeUsername.toLowerCase() }
                : {}),
              campusId,
              // A sheet without a Batch/Squad column says nothing about placement — it
              // does not say "remove them". Writing the null through would unassign the
              // whole cohort on any re-import that omits those columns, which is exactly
              // the kind of silent, roster-wide edit an import must never make.
              ...(batchId !== null ? { batchId } : {}),
              ...(squadId !== null ? { squadId } : {}),
              // Naming someone on the current roster is the statement that they are on it,
              // so a student a previous roster archived comes back ACTIVE — with the
              // record that already holds their submissions, not a second one. Only
              // ARCHIVED is reversed here: DROPPED, PAUSED and INACTIVE are mentors'
              // deliberate judgements about a student who *is* on the roster, and an
              // import has no business overruling them.
              ...(existing.status === 'ARCHIVED'
                ? { status: 'ACTIVE' as const, archivedAt: null, archivedReason: null }
                : {}),
              ...placement,
            },
          });
          updated += 1;
        } else {
          const fresh = await this.prisma.student.create({
            data: {
              name: row.name,
              // A sheet that omits the email does not say "remove it": only a supplied
              // value overwrites, exactly as batch and squad behave.
              ...(row.email ? { email: row.email } : {}),
              ...(row.registerNumber ? { registerNumber: row.registerNumber } : {}),
              phone: row.phone,
              ...(row.leetcodeUsername
                ? { leetcodeUsername: row.leetcodeUsername.toLowerCase() }
                : {}),
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
          onRoster.add(fresh.id);
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

    // Reconciliation runs only after every row has been processed, so a student is
    // archived on the strength of the *whole* roster rather than of the rows seen so far.
    // A row that failed to save leaves its student off `onRoster`, which would archive
    // someone the roster does name — so a run with errors refuses to reconcile rather
    // than acting on a roster it could not fully apply.
    let archived: ArchivedStudent[] | undefined;
    if (options.archiveAbsent) {
      if (errors.length > 0) {
        warnings.push({
          row: 0,
          field: null,
          message:
            `Nobody was archived: ${errors.length} row(s) could not be imported, so the ` +
            'roster was not fully applied and anyone missing from it may simply be a ' +
            'failed row. Fix the errors and re-run.',
          data: {},
        });
        archived = [];
      } else {
        archived = await this.archiveAbsent(
          campusId!,
          onRoster,
          options.archiveReason ?? 'Not on the current roster',
        );
      }
    }

    this.logger.log(
      `Import complete: ${created} created, ${updated} updated, ${skipped} skipped, ` +
        `${archived ? `${archived.length} archived, ` : ''}` +
        `${errors.length} errors, ${warnings.length} warnings`,
    );

    return {
      totalRows: rows.length,
      created,
      updated,
      skipped,
      errors,
      warnings,
      createdBatches,
      createdSquads,
      ...(archived ? { archived } : {}),
    };
  }

  /**
   * The student this row refers to, if the system already knows them.
   *
   * Identity, most reliable first. Email when the sheet has one; otherwise the register
   * number, then the LeetCode handle, then the name *within this campus*. Without the
   * fallbacks a roster with no emails would create fresh duplicates on every run, which
   * is the opposite of an idempotent import.
   *
   * Deliberately not scoped to ACTIVE students: someone archived by a previous roster and
   * named again by this one is the *same person* returning, and matching them updates and
   * reactivates the record that already holds their submissions rather than creating a
   * second student who shares their handle — which the unique index would reject anyway.
   *
   * One method, called by both the dry run and the real run, so the two can never report
   * different numbers for the same roster.
   */
  private async findExisting(row: ParsedRow, campusId: string) {
    const identity: Prisma.StudentWhereInput[] = [];
    if (row.email) identity.push({ email: row.email });
    if (row.registerNumber) identity.push({ registerNumber: row.registerNumber });
    if (row.leetcodeUsername) {
      identity.push({ leetcodeUsername: row.leetcodeUsername.toLowerCase() });
    }
    // Name is only an identity *inside one campus*: two campuses can each have a
    // "Rahul Sharma" and they are different people.
    identity.push({ name: row.name, campusId });

    return this.prisma.student.findFirst({ where: { OR: identity } });
  }

  /** Active students at this campus that the roster did not name. Read-only. */
  private async absentFromRoster(
    campusId: string,
    onRoster: Set<string>,
  ): Promise<ArchivedStudent[]> {
    const absent = await this.prisma.student.findMany({
      where: {
        campusId,
        status: 'ACTIVE',
        ...(onRoster.size > 0 ? { id: { notIn: [...onRoster] } } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        leetcodeUsername: true,
        squad: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });

    return absent.map((student) => ({
      id: student.id,
      name: student.name,
      email: student.email,
      leetcodeUsername: student.leetcodeUsername,
      squad: student.squad?.name ?? null,
    }));
  }

  /**
   * Archive the students this campus's roster no longer names.
   *
   * **Archive, never delete.** A student who has left still owns submissions, daily
   * statuses, baseline results, leaderboard entries and placement history, and every
   * report about a day they were present has to keep resolving them. Deleting would
   * cascade through all of it and silently rewrite the past; archiving drops them out of
   * the current roster — the `status: ACTIVE` filter every current-roster query already
   * applies — and leaves the history untouched. It is also reversible, which is the
   * property that matters most when the input is a hand-assembled roster.
   *
   * `archivedAt`/`archivedReason` are set alongside the status rather than inferred from
   * it, so "when did they leave and why" survives a later status change.
   */
  private async archiveAbsent(
    campusId: string,
    onRoster: Set<string>,
    reason: string,
  ): Promise<ArchivedStudent[]> {
    const absent = await this.absentFromRoster(campusId, onRoster);
    if (absent.length === 0) return absent;

    await this.prisma.student.updateMany({
      where: { id: { in: absent.map((student) => student.id) } },
      data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason },
    });

    this.logger.log(
      `Archived ${absent.length} student(s) at campus ${campusId} who are not on the ` +
        'supplied roster',
    );
    return absent;
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

  /**
   * Normalise one already-extracted row into the shape the importer validates.
   *
   * The spreadsheet parser and the JSON endpoint both land here, so a value means the same
   * thing however it arrived — the same handle extraction, the same lowercasing, the same
   * treatment of a blank cell as absent rather than as an empty string.
   */
  toParsedRow(
    raw: {
      name: string;
      email: string;
      squad: string;
      batch: string;
      leetcode: string;
      registerNumber: string;
      phone: string;
    },
    rowNumber: number,
  ): ParsedRow {
    const leetcode = raw.leetcode.trim();
    return {
      rowNumber,
      name: raw.name.trim(),
      email: raw.email.trim().toLowerCase(),
      batch: raw.batch.trim() || null,
      squad: raw.squad.trim() || null,
      leetcodeUsername: leetcode ? this.normaliseUsername(leetcode) : '',
      rawLeetcode: leetcode || null,
      registerNumber: raw.registerNumber.trim() || null,
      phone: raw.phone.trim() || null,
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
        rawLeetcode: username || null,
        registerNumber: read('registerNumber') || null,
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
  /**
   * The handle a LeetCode column refers to, via the shared resolver.
   *
   * Previously a local regex that treated the last path segment of *any* leetcode.com URL
   * as a handle — so `leetcode.com/profile/someone` was silently accepted as the handle
   * "someone", which is a guess about a URL that is not a profile link at all. The shared
   * resolver already distinguishes a real `/u/` profile, a non-profile URL, a bare handle
   * and a handle recoverable from a pasted page title, and it is unit-tested. One rule,
   * used everywhere, beats two that disagree about the same string.
   *
   * Returns **empty** when nothing resolves — not the raw value. A string that is not a
   * handle is not a handle, and returning the URL made every student sharing
   * `leetcode.com/profile/` collide with the others as a "duplicate handle", rejecting all
   * but the first. The original text is kept on `rawLeetcode` so the warning can quote what
   * the sheet actually said.
   */
  private normaliseUsername(raw: string): string {
    return resolveLeetcodeProfile(raw).username ?? '';
  }

  /**
   * Why a LeetCode column could not be trusted, in the vocabulary the operator needs:
   * `INVALID_PROFILE` for a link that is not a profile, `NEEDS_PROFILE_URL` for anything
   * that did not resolve to a handle. `null` when the value is usable.
   *
   * A handle recovered from a pasted page title resolves but is still flagged, because
   * LeetCode wrote that title and nothing in the row confirms the handle still exists —
   * the post-import validation pass is what settles those.
   */
  private profileIssue(raw: string): { state: string; message: string } | null {
    const resolved = resolveLeetcodeProfile(raw);
    if (resolved.username) return null;

    return resolved.resolution === 'NON_PROFILE_URL'
      ? {
          state: 'INVALID_PROFILE',
          message:
            'This is a generic LeetCode page, not a student profile. Supply the ' +
            "student's own https://leetcode.com/u/<handle>/ link.",
        }
      : {
          state: 'NEEDS_PROFILE_URL',
          message: `Could not read a LeetCode handle from "${raw.trim()}" (${resolved.resolution}).`,
        };
  }

  /**
   * Split deliberately: an **error** means the row cannot become a student, a **warning**
   * means it can and something still needs a human. A bad LeetCode profile is a warning,
   * because an invalid profile is not an invalid person — dropping those rows would leave
   * the programme with members the system cannot see.
   */
  private validateRow(row: ParsedRow): { errors: ImportRowError[]; warnings: ImportRowError[] } {
    const errors: ImportRowError[] = [];
    const warnings: ImportRowError[] = [];
    const data = { name: row.name, email: row.email, leetcodeUsername: row.leetcodeUsername };

    if (!row.name) {
      errors.push({ row: row.rowNumber, field: 'name', message: 'Name is required', data });
    }
    // Email is no longer required to *create* a student. A roster can legitimately arrive
    // without addresses, and refusing those rows means the programme has people it cannot
    // see — while inventing addresses creates students who can never log in and whom the
    // later correct import duplicates instead of updating. A student with no email is
    // imported and reported as EMAIL_REQUIRED; they simply have no portal login yet.
    if (row.email && !EMAIL_PATTERN.test(row.email)) {
      errors.push({
        row: row.rowNumber,
        field: 'email',
        message: `"${row.email}" is not a valid email address`,
        data,
      });
    }
    // A missing or unusable handle does not reject the student. Invalid profile is not
    // invalid person: the roster names someone who is in the programme, and dropping them
    // means the programme has a member the system cannot see. They import and sync as
    // `PROFILE_MISSING`, which reads as "nobody has collected a handle yet" rather than as
    // a failure — and the row is still reported so it can be chased.
    if (!row.leetcodeUsername) {
      if (row.rawLeetcode) {
        const issue = this.profileIssue(row.rawLeetcode);
        if (issue) {
          warnings.push({
            row: row.rowNumber,
            field: 'leetcodeUsername',
            message: `${issue.state}: ${issue.message}`,
            data,
          });
        }
      } else {
        warnings.push({
          row: row.rowNumber,
          field: 'leetcodeUsername',
          message:
            'NEEDS_PROFILE_URL: no LeetCode profile supplied. The student is imported and ' +
            'will sync as PROFILE_MISSING until one is added.',
          data,
        });
      }
    } else if (!USERNAME_PATTERN.test(row.leetcodeUsername)) {
      // Named in the operator's vocabulary rather than as a generic pattern failure: an
      // admin reading "not a valid username" about `leetcode.com/profile/` has to work out
      // what to do, while "this is a generic page, supply the student's own /u/ link" says
      // it. `rawLeetcode` is what the sheet held, before any extraction.
      const issue = this.profileIssue(row.rawLeetcode ?? row.leetcodeUsername);
      warnings.push({
        row: row.rowNumber,
        field: 'leetcodeUsername',
        message: issue
          ? `${issue.state}: ${issue.message}`
          : `"${row.leetcodeUsername}" is not a valid LeetCode username ` +
            '(letters, digits, underscore and hyphen only)',
        data,
      });
    }

    return { errors, warnings };
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
      pairs.set(this.squadKey(row.batch, row.squad), {
        batch: row.batch,
        squad: canonicalSquadName(row.squad),
      });
    }

    for (const [key, pair] of pairs) {
      const batchId = pair.batch ? (batchIds.get(pair.batch.toLowerCase()) ?? null) : null;

      // Matched on the canonical name, so a sheet saying "69", "squad 69" or "Squad 69"
      // all resolve to the one squad. Matching the raw text created a second squad called
      // "69" beside the existing "Squad 69" — the same cohort split across two rows, half
      // the students invisible to any filter on either.
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
  /** Keyed on the canonical squad name, so "69" and "Squad 69" are one entry, not two. */
  private squadKey(batch: string | null, squad: string | null): string {
    const canonical = squad ? canonicalSquadName(squad).toLowerCase() : '';
    return `${(batch ?? '').toLowerCase()}::${canonical}`;
  }
}

/**
 * The one spelling of a squad name.
 *
 * Sheets arrive with "69", "squad 69", "Squad 69" and "SQUAD 69" for the same group. A bare
 * or differently-cased number becomes the canonical "Squad 69"; anything that is not a
 * squad number at all (a named pod, say) is kept verbatim rather than mangled.
 */
function canonicalSquadName(raw: string): string {
  const number = normaliseSquadNumber(raw);
  return number === null ? raw.trim() : squadName(number);
}
