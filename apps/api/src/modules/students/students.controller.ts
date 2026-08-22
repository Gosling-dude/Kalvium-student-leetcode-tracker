import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { StudentImportService } from './student-import.service';
import { StudentsService } from './students.service';
import { CampusesService } from '../campuses/campuses.service';
import {
  BulkIdsDto,
  BulkUpdateStudentsDto,
  CreateNoteDto,
  CreateStudentDto,
  ImportStudentsDto,
  StudentQueryDto,
  UpdateStudentDto,
} from './dto/student.dto';

/** Excel files are small; a 10 MB ceiling stops an upload from exhausting memory. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * The shape multer hands us. Declared locally rather than pulling in `@types/multer`
 * purely to name one field — this is the entire surface the controller touches.
 */
interface UploadedExcelFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly importer: StudentImportService,
    private readonly campuses: CampusesService,
  ) {}

  /**
   * `?campus=` and `?batch=` accept ids, codes (`SRM`, `A`) or aliases (`foundation`),
   * and are resolved to ids here so the service only ever filters on ids. The pair is
   * resolved *together*, so `campus=SRM&batch=A` can only mean SRM's Foundation.
   *
   * An unknown value is rejected rather than ignored — silently dropping a bad filter
   * would show a mentor every campus's students under one campus's heading, which is the
   * cross-campus leak §12 exists to prevent.
   */
  @Get()
  @ApiOperation({ summary: 'Search, filter and paginate students across campuses' })
  async findAll(@Query() query: StudentQueryDto) {
    // Mutated rather than spread: `skip`/`take` are getters on `PaginationQueryDto`, and
    // spreading the instance would silently drop them and paginate from row 0 every time.
    if (query.campus || query.batch) {
      const scope = await this.campuses.resolveScope({
        campus: query.campus,
        batch: query.batch,
      });
      query.campusId = scope.campusId ?? undefined;
      query.batchId = scope.batchId ?? undefined;
      // `batch=none` asks for students with no batch — a third state that a batch id
      // cannot carry, since an absent id already means "every batch".
      if (scope.onlyUnassigned) query.unassigned = true;
    }
    return this.students.findAll(query);
  }

  @Get('filters')
  @ApiOperation({ summary: 'Campus, batch, cohort and squad options for filter controls' })
  filters() {
    return this.students.getFilterOptions();
  }

  @Get('import/template')
  @ApiOperation({ summary: 'Download the student import template' })
  async template(@Res() res: Response): Promise<void> {
    const buffer = await this.importer.buildTemplate();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="dsa-tracker-students.xlsx"');
    res.send(buffer);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single student' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.findOne(id);
  }

  @Get(':id/profile')
  @ApiOperation({ summary: 'Full student profile: level, badges, heatmap, history' })
  profile(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.getProfile(id);
  }

  @Post()
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENT_CREATED', 'Student')
  @ApiOperation({ summary: 'Add a student' })
  create(@Body() dto: CreateStudentDto) {
    return this.students.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENT_UPDATED', 'Student')
  @ApiOperation({ summary: 'Update a student' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStudentDto) {
    return this.students.update(id, dto);
  }

  /**
   * Removes a student from the current programme.
   *
   * A student with history is archived rather than deleted — their submissions and
   * results are the only copy that exists (§24). The response says which happened, so
   * the UI can tell the admin the truth instead of implying the rows are gone.
   */
  @Delete(':id')
  @Roles('ADMIN')
  @Audit('STUDENT_REMOVED', 'Student')
  @ApiOperation({ summary: 'Remove a student — archived when they have history, deleted when they do not' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.remove(id);
  }

  @Post('bulk/delete')
  @Roles('ADMIN')
  @Audit('STUDENTS_BULK_REMOVED', 'Student')
  @ApiOperation({ summary: 'Remove many students — archiving any that have history' })
  bulkDelete(@Body() dto: BulkIdsDto) {
    return this.students.removeMany(dto.ids);
  }

  @Post('bulk/update')
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENTS_BULK_UPDATED', 'Student')
  @ApiOperation({ summary: 'Reassign batch, squad or status for many students' })
  async bulkUpdate(@Body() dto: BulkUpdateStudentsDto) {
    return {
      updated: await this.students.bulkUpdate(dto.ids, {
        squadId: dto.squadId,
        batchId: dto.batchId,
        status: dto.status,
      }),
    };
  }

  @Post('import')
  @Roles('ADMIN', 'MENTOR')
  @Audit('STUDENTS_IMPORTED', 'Student')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        dryRun: { type: 'boolean' },
        updateExisting: { type: 'boolean' },
      },
    },
  })
  @ApiOperation({ summary: 'Import students from an Excel workbook' })
  @ApiResponse({
    status: 201,
    description: 'Per-row results. Valid rows import even when others fail.',
  })
  async importStudents(
    @UploadedFile() file: UploadedExcelFile | undefined,
    @Body() dto: ImportStudentsDto,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded (expected field "file")');
    return this.importer.import(file.buffer, {
      dryRun: dto.dryRun,
      updateExisting: dto.updateExisting,
    });
  }

  @Post(':id/notes')
  @Roles('ADMIN', 'MENTOR')
  @ApiOperation({ summary: 'Add a mentor note to a student' })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateNoteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.students.addNote(id, user.id, dto.body, dto.isPrivate ?? false);
  }

  @Delete('notes/:noteId')
  @Roles('ADMIN', 'MENTOR')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a mentor note' })
  async deleteNote(@Param('noteId', ParseUUIDPipe) noteId: string): Promise<void> {
    await this.students.deleteNote(noteId);
  }
}
