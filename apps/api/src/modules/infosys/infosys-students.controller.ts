import { Body, Controller, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators';
import { InfosysStudentsService } from './infosys-students.service';
import { UpdateInfosysStudentDto } from './dto/infosys-student.dto';

@ApiTags('Infosys students')
@ApiBearerAuth()
@Controller('infosys/students')
export class InfosysStudentsController {
  constructor(private readonly students: InfosysStudentsService) {}

  @Patch(':studentId')
  @Roles('ADMIN', 'MENTOR')
  @ApiOperation({
    summary: 'Edit one Infosys student — name, email, campus, and/or LeetCode profile',
    description:
      'A supplied LeetCode profile is verified live before saving and never overwrites a valid ' +
      'existing one with blank/invalid data. A successful profile change triggers that student’s ' +
      'whole Infosys history to be recomputed automatically.',
  })
  update(@Param('studentId', ParseUUIDPipe) studentId: string, @Body() dto: UpdateInfosysStudentDto) {
    return this.students.update(studentId, dto);
  }
}
