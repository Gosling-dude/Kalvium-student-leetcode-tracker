import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { BatchesModule } from '../batches/batches.module';
import { StudentImportService } from './student-import.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [ScoringModule, BatchesModule],
  controllers: [StudentsController],
  providers: [StudentsService, StudentImportService],
  exports: [StudentsService, StudentImportService],
})
export class StudentsModule {}
