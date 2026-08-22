import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { CampusesModule } from '../campuses/campuses.module';
import { BatchesModule } from './batches.module';
import { BatchesController, StudentBatchController } from './batches.controller';

/** Routes for batches and for the batch operations that hang off a student. */
@Module({
  imports: [BatchesModule, CampusesModule, StudentsModule],
  controllers: [BatchesController, StudentBatchController],
})
export class BatchesHttpModule {}
