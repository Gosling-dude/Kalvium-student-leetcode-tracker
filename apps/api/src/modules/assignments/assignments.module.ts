import { Module } from '@nestjs/common';
import { BatchesModule } from '../batches/batches.module';
import { CampusesModule } from '../campuses/campuses.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

@Module({
  // `ScoringModule` so deleting an assignment can re-settle the day it belonged to.
  // One-directional: scoring has no handle on assignments, so this adds no cycle.
  imports: [BatchesModule, CampusesModule, ScoringModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
