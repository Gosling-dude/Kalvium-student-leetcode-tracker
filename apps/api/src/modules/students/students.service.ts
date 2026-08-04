import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Student } from '@prisma/client';
import {
  completionPercentage,
  evaluateAchievements,
  heatmapIntensity,
  levelProgress,
  type Paginated,
  type StudentProfile,
  type StudentSummary,
  type SyncStatus,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate, safeSortField } from '../../common/dto/pagination.dto';
import type { CreateStudentDto, StudentQueryDto, UpdateStudentDto } from './dto/student.dto';

const SORTABLE = [
  'name',
  'email',
  'createdAt',
  'currentStreak',
  'longestStreak',
  'totalSolved',
  'totalScore',
] as const;

type StudentWithRelations = Student & {
  batch: { id: string; name: string } | null;
  group: { id: string; name: string } | null;
  syncState: { status: string; lastSyncedAt: Date | null } | null;
};

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
  ) {}

  async findAll(query: StudentQueryDto): Promise<Paginated<StudentSummary>> {
    const where = this.buildWhere(query);
    const sortBy = safeSortField(query.sortBy, SORTABLE, 'name');

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({
        where,
        include: { batch: true, group: true, syncState: true },
        orderBy: { [sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.student.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toSummary(row as StudentWithRelations)),
      total,
      query.page,
      query.pageSize,
    );
  }

  async findOne(id: string): Promise<StudentSummary> {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: { batch: true, group: true, syncState: true },
    });
    if (!student) throw new NotFoundException(`Student ${id} was not found`);
    return this.toSummary(student as StudentWithRelations);
  }

  async create(dto: CreateStudentDto): Promise<StudentSummary> {
    const student = await this.prisma.student.create({
      data: {
        name: dto.name,
        email: dto.email.toLowerCase(),
        phone: dto.phone ?? null,
        leetcodeUsername: dto.leetcodeUsername.toLowerCase(),
        batchId: dto.batchId ?? null,
        groupId: dto.groupId ?? null,
        status: dto.status ?? 'ACTIVE',
        syncState: { create: { status: 'NEVER_SYNCED' } },
      },
      include: { batch: true, group: true, syncState: true },
    });
    return this.toSummary(student as StudentWithRelations);
  }

  async update(id: string, dto: UpdateStudentDto): Promise<StudentSummary> {
    await this.assertExists(id);

    // Changing the LeetCode handle invalidates the sync cursor: submissions already
    // mirrored belong to the *old* account, and the new one must be re-read from scratch.
    const usernameChanged = dto.leetcodeUsername !== undefined;

    const student = await this.prisma.student.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.email !== undefined ? { email: dto.email.toLowerCase() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.leetcodeUsername !== undefined
          ? { leetcodeUsername: dto.leetcodeUsername.toLowerCase() }
          : {}),
        ...(dto.batchId !== undefined ? { batchId: dto.batchId } : {}),
        ...(dto.groupId !== undefined ? { groupId: dto.groupId } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(usernameChanged
          ? {
              syncState: {
                upsert: {
                  create: { status: 'NEVER_SYNCED' },
                  update: {
                    status: 'NEVER_SYNCED',
                    lastSubmissionAt: null,
                    lastProviderSubmissionId: null,
                    lastError: null,
                    consecutiveFailures: 0,
                  },
                },
              },
            }
          : {}),
      },
      include: { batch: true, group: true, syncState: true },
    });

    return this.toSummary(student as StudentWithRelations);
  }

  async remove(id: string): Promise<void> {
    await this.assertExists(id);
    await this.prisma.student.delete({ where: { id } });
  }

  async removeMany(ids: string[]): Promise<number> {
    const result = await this.prisma.student.deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }

  /** Bulk reassignment — the operation mentors actually perform on a selection. */
  async bulkUpdate(
    ids: string[],
    changes: { groupId?: string | null; batchId?: string | null; status?: string },
  ): Promise<number> {
    const result = await this.prisma.student.updateMany({
      where: { id: { in: ids } },
      data: {
        ...(changes.groupId !== undefined ? { groupId: changes.groupId } : {}),
        ...(changes.batchId !== undefined ? { batchId: changes.batchId } : {}),
        ...(changes.status !== undefined
          ? { status: changes.status as Student['status'] }
          : {}),
      },
    });
    return result.count;
  }

  /** Full profile page: level, achievements, heatmap and recent history. */
  async getProfile(id: string, days = 120): Promise<StudentProfile> {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: { batch: true, group: true, syncState: true },
    });
    if (!student) throw new NotFoundException(`Student ${id} was not found`);

    const today = this.time.today();
    const from = this.time.addDays(today, -(days - 1));

    const [statuses, notes, achievements] = await this.prisma.$transaction([
      this.prisma.dailyStatus.findMany({
        where: { studentId: id, dayKey: { gte: from, lte: today } },
        orderBy: { dayKey: 'asc' },
      }),
      this.prisma.mentorNote.findMany({
        where: { studentId: id },
        include: { author: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.studentAchievement.findMany({ where: { studentId: id } }),
    ]);

    const week = this.time.weekBounds(today);
    const month = this.time.monthBounds(today);
    const inRange = (from_: string, to: string) =>
      statuses.filter((s) => s.dayKey >= from_ && s.dayKey <= to);

    const weekRows = inRange(week.from, week.to);
    const monthRows = inRange(month.from, month.to);

    const perfectDays = statuses.filter((s) => s.isPerfect).length;
    const earlyFinishes = statuses.filter(
      (s) => s.completionMinute !== null && s.completionMinute < 9 * 60,
    ).length;
    const weekendPerfect = statuses.filter(
      (s) => s.isPerfect && this.time.isWeekend(s.dayKey),
    ).length;

    const bestRank = await this.prisma.leaderboardEntry.aggregate({
      where: { studentId: id, period: 'DAILY' },
      _min: { rank: true },
    });

    const context = {
      currentStreak: student.currentStreak,
      longestStreak: student.longestStreak,
      totalSolved: student.totalSolved,
      perfectDays,
      perfectWeeks: 0,
      earlyFinishes,
      weekendPerfectDays: weekendPerfect,
      bestDailyRank: bestRank._min.rank ?? null,
      scoreImprovement: 0,
      hardSolved: student.hardSolved,
      mediumSolved: student.mediumSolved,
      distinctTopics: 0,
      activeDays: statuses.filter((s) => s.solvedCount > 0).length,
    };

    const unlocked = new Set(achievements.map((a) => a.code));
    const evaluated = evaluateAchievements(context).map((a) => ({
      ...a,
      // A badge already recorded as unlocked stays unlocked even if the underlying
      // statistic later dips — achievements are historical facts, not current state.
      earned: a.earned || unlocked.has(a.code),
    }));

    return {
      ...this.toSummary(student as StudentWithRelations),
      levelProgress: levelProgress(student.totalScore),
      achievements: evaluated,
      difficultyBreakdown: {
        easy: student.easySolved,
        medium: student.mediumSolved,
        hard: student.hardSolved,
        total: student.totalSolved,
      },
      heatmap: statuses.map((s) => ({
        dayKey: s.dayKey,
        solvedCount: s.solvedCount,
        assignedCount: s.assignedCount,
        intensity: heatmapIntensity(s.solvedCount, s.assignedCount),
      })),
      recentDays: statuses
        .slice(-30)
        .reverse()
        .map((s) => ({
          dayKey: s.dayKey,
          solvedCount: s.solvedCount,
          assignedCount: s.assignedCount,
          score: s.score,
          completionTime: this.time.localTime(s.completedAt),
        })),
      totalScore: student.totalScore,
      weeklyCompletionPercent: completionPercentage(
        weekRows.reduce((n, s) => n + s.solvedCount, 0),
        weekRows.reduce((n, s) => n + s.assignedCount, 0),
      ),
      monthlyCompletionPercent: completionPercentage(
        monthRows.reduce((n, s) => n + s.solvedCount, 0),
        monthRows.reduce((n, s) => n + s.assignedCount, 0),
      ),
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        authorId: n.authorId ?? '',
        authorName: n.author?.name ?? 'Unknown',
        createdAt: n.createdAt.toISOString(),
        updatedAt: n.updatedAt.toISOString(),
      })),
    };
  }

  async addNote(studentId: string, authorId: string, body: string, isPrivate = false) {
    await this.assertExists(studentId);
    return this.prisma.mentorNote.create({
      data: { studentId, authorId, body, isPrivate },
    });
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.prisma.mentorNote.delete({ where: { id: noteId } });
  }

  /** Distinct values powering the filter dropdowns. */
  async getFilterOptions() {
    const [batches, groups] = await this.prisma.$transaction([
      this.prisma.batch.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { students: true } } },
      }),
      this.prisma.group.findMany({
        orderBy: { name: 'asc' },
        include: {
          batch: { select: { name: true } },
          mentor: { select: { id: true, name: true } },
          _count: { select: { students: true } },
        },
      }),
    ]);

    return {
      batches: batches.map((b) => ({
        id: b.id,
        name: b.name,
        studentCount: b._count.students,
        startDate: b.startDate?.toISOString() ?? null,
        isActive: b.isActive,
      })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        batchId: g.batchId,
        batchName: g.batch?.name ?? null,
        mentorId: g.mentorId,
        mentorName: g.mentor?.name ?? null,
        studentCount: g._count.students,
        color: g.color,
      })),
    };
  }

  // -------------------------------------------------------------------------

  private buildWhere(query: StudentQueryDto): Prisma.StudentWhereInput {
    const search = query.search?.trim();

    return {
      ...(query.groupId ? { groupId: query.groupId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.syncStatus ? { syncState: { status: query.syncStatus } } : {}),
      ...(query.minStreak !== undefined ? { currentStreak: { gte: query.minStreak } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { leetcodeUsername: { contains: search, mode: 'insensitive' } },
              { group: { name: { contains: search, mode: 'insensitive' } } },
              { batch: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private async assertExists(id: string): Promise<void> {
    const count = await this.prisma.student.count({ where: { id } });
    if (count === 0) throw new NotFoundException(`Student ${id} was not found`);
  }

  private toSummary(student: StudentWithRelations): StudentSummary {
    return {
      id: student.id,
      name: student.name,
      email: student.email,
      phone: student.phone,
      leetcodeUsername: student.leetcodeUsername,
      status: student.status,
      batchId: student.batchId,
      batchName: student.batch?.name ?? null,
      groupId: student.groupId,
      groupName: student.group?.name ?? null,
      avatarUrl: student.avatarUrl,
      syncStatus: (student.syncState?.status ?? 'NEVER_SYNCED') as SyncStatus,
      lastSyncedAt: student.syncState?.lastSyncedAt?.toISOString() ?? null,
      currentStreak: student.currentStreak,
      longestStreak: student.longestStreak,
      totalSolved: student.totalSolved,
      createdAt: student.createdAt.toISOString(),
    };
  }
}
