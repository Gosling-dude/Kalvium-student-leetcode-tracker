/**
 * Blocker recording (§8, §9).
 *
 * `solvedCount`/`assignedCount` are never taken from the client — they are snapshotted
 * here from the same `DailyStatus` the rest of the report reads, so a mentor cannot
 * (accidentally or otherwise) record a blocker against numbers that don't match what
 * the report shows.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import type { BlockerRecord, DayKey } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CreateBlockerDto, UpdateBlockerDto } from './dto/email-reports.dto';

@Injectable()
export class BlockersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateBlockerDto, userId: string): Promise<BlockerRecord> {
    const status = await this.prisma.dailyStatus.findUnique({
      where: { studentId_dayKey: { studentId: dto.studentId, dayKey: dto.dayKey } },
    });

    const row = await this.prisma.blocker.upsert({
      where: { studentId_dayKey: { studentId: dto.studentId, dayKey: dto.dayKey } },
      create: {
        studentId: dto.studentId,
        dayKey: dto.dayKey,
        solvedCount: status?.solvedCount ?? 0,
        assignedCount: status?.assignedCount ?? 0,
        category: dto.category,
        description: dto.description ?? null,
        actionTaken: dto.actionTaken ?? null,
        followUpRequired: dto.followUpRequired ?? false,
        followUpDate: dto.followUpDate ?? null,
        mentorNotes: dto.mentorNotes ?? null,
        recordedById: userId,
      },
      update: {
        category: dto.category,
        description: dto.description ?? null,
        actionTaken: dto.actionTaken ?? null,
        followUpRequired: dto.followUpRequired ?? false,
        followUpDate: dto.followUpDate ?? null,
        mentorNotes: dto.mentorNotes ?? null,
        recordedById: userId,
      },
      include: { student: { select: { name: true } }, recordedBy: { select: { name: true } } },
    });

    return this.toRecord(row);
  }

  async update(id: string, dto: UpdateBlockerDto, userId: string): Promise<BlockerRecord> {
    const existing = await this.prisma.blocker.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`No blocker record with id "${id}"`);

    const row = await this.prisma.blocker.update({
      where: { id },
      data: {
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.actionTaken !== undefined ? { actionTaken: dto.actionTaken } : {}),
        ...(dto.followUpRequired !== undefined ? { followUpRequired: dto.followUpRequired } : {}),
        ...(dto.followUpDate !== undefined ? { followUpDate: dto.followUpDate } : {}),
        ...(dto.mentorNotes !== undefined ? { mentorNotes: dto.mentorNotes } : {}),
        ...(dto.resolved ? { resolvedAt: new Date() } : {}),
        recordedById: userId,
      },
      include: { student: { select: { name: true } }, recordedBy: { select: { name: true } } },
    });

    return this.toRecord(row);
  }

  async list(dayKey?: DayKey, studentId?: string): Promise<BlockerRecord[]> {
    const rows = await this.prisma.blocker.findMany({
      where: { ...(dayKey ? { dayKey } : {}), ...(studentId ? { studentId } : {}) },
      include: { student: { select: { name: true } }, recordedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toRecord(row));
  }

  private toRecord(row: {
    id: string;
    studentId: string;
    student: { name: string };
    dayKey: string;
    solvedCount: number;
    assignedCount: number;
    category: BlockerRecord['category'];
    description: string | null;
    actionTaken: string | null;
    followUpRequired: boolean;
    followUpDate: string | null;
    mentorNotes: string | null;
    resolvedAt: Date | null;
    recordedById: string | null;
    recordedBy: { name: string } | null;
    createdAt: Date;
    updatedAt: Date;
  }): BlockerRecord {
    return {
      id: row.id,
      studentId: row.studentId,
      studentName: row.student.name,
      dayKey: row.dayKey,
      solvedCount: row.solvedCount,
      assignedCount: row.assignedCount,
      category: row.category,
      description: row.description,
      actionTaken: row.actionTaken,
      followUpRequired: row.followUpRequired,
      followUpDate: row.followUpDate,
      mentorNotes: row.mentorNotes,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      recordedById: row.recordedById,
      recordedByName: row.recordedBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
