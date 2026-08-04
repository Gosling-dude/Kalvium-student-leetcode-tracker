import {
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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { AssignmentsService } from './assignments.service';
import {
  AssignmentQueryDto,
  CreateAssignmentDto,
  PreviewProblemDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get()
  @ApiOperation({ summary: 'Assignment history' })
  findAll(@Query() query: AssignmentQueryDto) {
    return this.assignments.findAll({
      page: query.page,
      pageSize: query.pageSize,
      from: query.from,
      to: query.to,
      search: query.search,
    });
  }

  @Get('today')
  @ApiOperation({ summary: "Today's assignment" })
  today() {
    return this.assignments.findToday();
  }

  @Get('day/:dayKey')
  @ApiOperation({ summary: 'Assignment for a specific date' })
  byDay(@Param('dayKey') dayKey: string) {
    return this.assignments.findByDay(dayKey);
  }

  @Post('preview')
  @Roles('ADMIN', 'MENTOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fetch problem metadata for a URL before saving' })
  preview(@Body() dto: PreviewProblemDto) {
    return this.assignments.previewProblem(dto.url);
  }

  @Post()
  @Roles('ADMIN', 'MENTOR')
  @Audit('ASSIGNMENT_CREATED', 'Assignment')
  @ApiOperation({ summary: 'Create the assignment for a day' })
  create(@Body() dto: CreateAssignmentDto, @CurrentUser() user: RequestUser) {
    return this.assignments.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MENTOR')
  @Audit('ASSIGNMENT_UPDATED', 'Assignment')
  @ApiOperation({ summary: 'Update an assignment' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssignmentDto) {
    return this.assignments.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('ASSIGNMENT_DELETED', 'Assignment')
  @ApiOperation({ summary: 'Delete an assignment' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.assignments.remove(id);
  }
}
