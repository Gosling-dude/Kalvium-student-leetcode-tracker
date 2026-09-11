/**
 * The first day the tracker can honestly state a complete number for each student.
 *
 * One question, one answer, for the two places that act on it: `RollupService`, which
 * refuses to write a row before it, and `DashboardService`, which explains the resulting
 * gap as `NOT_OBSERVED`. Those two derived it independently before, and a disagreement
 * between them puts the same student in a solved-count bucket *and* on the "not observed"
 * list of the same day — two contradictory answers on one screen.
 *
 * The rule is `Student.createdAt`, and `resolveObservedFromDay` in `@dsa/shared` records
 * at length why neither placement history nor a surviving submission widens it. Both look
 * like fixes for the late-added-assignment problem and both would write measurements
 * nobody took.
 *
 * The read is batched because resolving it per student inside the rollup's loop would be
 * one query per student per day.
 */

import { Injectable } from '@nestjs/common';
import { resolveObservedFromDay, type DayKey } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from './program-time.service';

@Injectable()
export class EnrolmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
  ) {}

  /** The observed-from day for each of `studentIds` — or for every student when omitted. */
  async observedFromDayByStudent(studentIds?: string[]): Promise<Map<string, DayKey>> {
    const scoped = studentIds !== undefined && studentIds.length > 0;

    const students = await this.prisma.student.findMany({
      where: scoped ? { id: { in: studentIds } } : {},
      select: { id: true, createdAt: true },
    });

    const result = new Map<string, DayKey>();
    for (const student of students) {
      result.set(
        student.id,
        resolveObservedFromDay({ createdAtDayKey: this.time.dayKeyOf(student.createdAt) }),
      );
    }
    return result;
  }

  /** Single-student form. Prefer the batch version inside any loop. */
  async observedFromDayFor(studentId: string): Promise<DayKey | null> {
    return (await this.observedFromDayByStudent([studentId])).get(studentId) ?? null;
  }
}
