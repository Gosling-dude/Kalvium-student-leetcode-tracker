import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { AssignmentsModule } from '../assignments/assignments.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { StudentPortalController } from './student-portal.controller';
import { StudentPortalService } from './student-portal.service';

@Module({
  imports: [StudentsModule, AssignmentsModule, LeaderboardModule],
  controllers: [StudentPortalController],
  providers: [StudentPortalService],
})
export class StudentPortalModule {}
