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
import { CampusesService } from './campuses.service';
import { StudentsService } from '../students/students.service';
import { MentorScopeService } from './mentor-scope.service';
import { StudentQueryDto } from '../students/dto/student.dto';
import {
  CampusStatsQueryDto,
  CreateCampusDto,
  ListCampusesQueryDto,
  TransferCampusDto,
  UpdateCampusDto,
} from './dto/campus.dto';

/**
 * The batches every new campus starts with — the two levels, and nothing else.
 *
 * There is deliberately no batch for "not placed yet". A student awaiting their
 * diagnostic assessment simply has no batch, because a placeholder batch would appear in
 * every picker and every assignment target as somewhere work could be set.
 */
@ApiTags('Campuses')
@ApiBearerAuth()
@Controller('campuses')
export class CampusesController {
  constructor(
    private readonly campuses: CampusesService,
    private readonly students: StudentsService,
    private readonly prisma: PrismaService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All campuses, in display order' })
  findAll(@Query() query: ListCampusesQueryDto) {
    return this.campuses.findAll(query.includeArchived ?? false);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Per-campus student counts, placement-pending counts and completion' })
  stats(@Query() query: CampusStatsQueryDto) {
    return this.campuses.getStats(query.dayKey);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single campus' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.campuses.findById(id);
  }

  /**
   * The campus's batches — what the create-assignment form reads when the campus picker
   * changes, so the batch picker can only ever offer batches that campus actually has.
   */
  @Get(':id/batches')
  @ApiOperation({ summary: 'Batches at a campus, in display order' })
  async batches(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListCampusesQueryDto) {
    await this.campuses.findById(id);
    return this.campuses.batchesForCampus(id, query.includeArchived ?? false);
  }

  /**
   * The campus's students. Delegates to `StudentsService` rather than re-querying, so the
   * filtering, pagination and archived-student rules stay in one place — a second
   * implementation here is exactly how "archived students reappear on one screen" starts.
   */
  @Get(':id/students')
  @ApiOperation({ summary: 'Students at a campus' })
  async findStudents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StudentQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.campuses.findById(id);

    // The same campus rule as `GET /students`. This route names a campus in its path
    // rather than a query parameter, which makes it the obvious way around a filter that
    // only guarded the directory — so it is guarded here too, with the same empty-result
    // answer rather than a 403.
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (!this.mentorScope.canSeeCampus(id, allowed)) return this.students.emptyPage(query);

    // Mutated rather than spread — `skip`/`take` are getters and would be lost.
    query.campusId = id;
    return this.students.findAll(query);
  }

  @Post()
  @Roles('ADMIN')
  @Audit('CAMPUS_CREATED', 'Campus')
  @ApiOperation({ summary: 'Create a campus, with its standard batches' })
  async create(@Body() dto: CreateCampusDto) {
    // Delegates: the rules for creating a campus — clash detection, derived code, the
    // default batches — live in the service so the roster import applies exactly the same
    // ones.
    const created = await this.campuses.create(dto);
    return this.campuses.findById(created.id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @Audit('CAMPUS_UPDATED', 'Campus')
  @ApiOperation({ summary: 'Rename, re-describe, reorder or archive a campus' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampusDto) {
    const existing = await this.prisma.campus.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Campus ${id} was not found`);

    // Archiving a campus that still holds current students would drop them out of every
    // campus-filtered view while leaving them ACTIVE — transfer them out first. Same rule
    // batch archival follows, for the same reason.
    if (dto.status === 'ARCHIVED' && existing.status !== 'ARCHIVED') {
      const remaining = await this.prisma.student.count({
        where: { campusId: id, status: 'ACTIVE' },
      });
      if (remaining > 0) {
        throw new BadRequestException(
          `${existing.name} still has ${remaining} active student(s). Transfer them to another campus before archiving it.`,
        );
      }
    }

    await this.prisma.campus.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });

    return this.campuses.findById(id);
  }
}

/**
 * Campus operations that hang off a *student* rather than a campus.
 *
 * Kept in this module because they are campus behaviour — `StudentsService` should not
 * grow a second, subtly different way to write campus history. Mirrors
 * `StudentBatchController` exactly.
 */
@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentCampusController {
  constructor(private readonly campuses: CampusesService) {}

  @Get(':id/campus-history')
  @ApiOperation({ summary: "A student's campus placements over time, newest first" })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.campuses.getHistory(id);
  }

  /**
   * Only ADMIN and MENTOR reach this: a student must never be able to change their own
   * campus (§35). Enforcement is the global `RolesGuard`, not a check in the body.
   */
  @Post(':id/transfer-campus')
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENT_CAMPUS_TRANSFERRED', 'Student')
  @ApiOperation({ summary: 'Transfer a student to another campus, preserving all history' })
  async transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferCampusDto,
    @CurrentUser() user: RequestUser,
  ) {
    const result = await this.campuses.transferStudent({
      studentId: id,
      toCampusId: dto.toCampusId,
      toBatchId: dto.toBatchId ?? null,
      reason: dto.reason ?? null,
      changedById: user.id,
      changedByName: user.name,
      source: 'MANUAL',
    });

    return {
      studentId: result.student.id,
      name: result.student.name,
      fromCampusId: result.fromCampusId,
      toCampusId: result.toCampusId,
      fromBatchId: result.fromBatchId,
      toBatchId: result.toBatchId,
      history: await this.campuses.getHistory(id),
    };
  }
}
