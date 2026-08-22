import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { CampusesModule } from './campuses.module';
import { CampusesController, StudentCampusController } from './campuses.controller';

/** Routes for campuses and for the campus operations that hang off a student. */
@Module({
  imports: [CampusesModule, StudentsModule],
  controllers: [CampusesController, StudentCampusController],
})
export class CampusesHttpModule {}
