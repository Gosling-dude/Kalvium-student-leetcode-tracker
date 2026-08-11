import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { BatchesService } from './batches.service';
import { StudentsService } from '../students/students.service';
import { StudentQueryDto } from '../students/dto/student.dto';
import {
  BatchStatsQueryDto,
  CreateBatchDto,
  ListBatchesQueryDto,
  MoveBatchDto,
  UpdateBatchDto,
} from './dto/batch.dto';

@ApiTags('Batches')
@ApiBearerAuth()
@Controller('batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly students: StudentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All batches, in display order' })
  findAll(@Query() query: ListBatchesQueryDto) {
    return this.batches.findAll(query.includeArchived ?? false);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Per-batch student counts, completion, belt average and cohorts' })
  stats(@Query() query: BatchStatsQueryDto) {
    return this.batches.getStats(query.dayKey);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single batch' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.findById(id);
  }

  /**
   * The batch's students. Delegates to `StudentsService` rather than re-querying so the
   * filtering, pagination and archived-student rules stay in one place — a second
   * implementation here is exactly how "archived students reappear on one screen" starts.
   */
  @Get(':id/students')
  @ApiOperation({ summary: 'Students in a batch' })
  async findStudents(@Param('id', ParseUUIDPipe) id: string, @Query() query: StudentQueryDto) {
    await this.batches.findById(id);
    // Mutated rather than spread — `skip`/`take` are getters and would be lost.
    query.batchId = id;
    return this.students.findAll(query);
  }

  @Post()
  @Roles('ADMIN')
  @Audit('BATCH_CREATED', 'Batch')
  @ApiOperation({ summary: 'Create a batch' })
  async create(@Body() dto: CreateBatchDto) {
    const clash = await this.prisma.batch.findFirst({
      where: { OR: [{ code: dto.code }, { name: dto.name }] },
      select: { code: true, name: true },
    });
    if (clash) {
      throw new BadRequestException(
        clash.code === dto.code
          ? `A batch with code "${dto.code}" already exists.`
          : `A batch named "${dto.name}" already exists.`,
      );
    }

    const created = await this.prisma.batch.create({
      data: {
        name: dto.name,
        code: dto.code,
        description: dto.description ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return this.batches.findById(created.id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @Audit('BATCH_UPDATED', 'Batch')
  @ApiOperation({ summary: 'Rename, re-describe, reorder or archive a batch' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBatchDto) {
    const existing = await this.prisma.batch.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Batch ${id} was not found`);

    // Archiving a batch that still holds current students would orphan them from every
    // batch-filtered view while leaving them ACTIVE — move them out first.
    if (dto.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
      const remaining = await this.prisma.student.count({
        where: { batchId: id, status: 'ACTIVE' },
      });
      if (remaining > 0) {
        throw new BadRequestException(
          `"${existing.name}" still has ${remaining} active student(s). Move them to another batch before archiving it.`,
        );
      }
    }

    await this.prisma.batch.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.status !== undefined ? { status: dto.status, isActive: dto.status === 'ACTIVE' } : {}),
      },
    });

    return this.batches.findById(id);
  }
}

/**
 * Batch operations that hang off a *student* rather than a batch.
 *
 * Kept in this module because they are batch behaviour — `StudentsService` should not
 * grow a second, subtly different way to write batch history.
 */
@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentBatchController {
  constructor(private readonly batches: BatchesService) {}

  @Get(':id/batch-history')
  @ApiOperation({ summary: "A student's batch placements over time, newest first" })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.batches.getHistory(id);
  }

  /**
   * Only ADMIN and MENTOR reach this: a student must never be able to change their own
   * batch (§22). Enforcement is the global `RolesGuard`, not a check in the body.
   */
  @Post(':id/move-batch')
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENT_BATCH_MOVED', 'Student')
  @ApiOperation({ summary: 'Move a student to another batch, preserving all history' })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveBatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const result = await this.batches.moveStudent({
      studentId: id,
      toBatchId: dto.toBatchId,
      reason: dto.reason ?? null,
      changedById: user.id,
      changedByName: user.name,
      source: 'MANUAL',
    });

    return {
      studentId: result.student.id,
      name: result.student.name,
      fromBatchId: result.fromBatchId,
      toBatchId: result.toBatchId,
      history: await this.batches.getHistory(id),
    };
  }
}
