import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CampusesModule } from '../campuses/campuses.module';
import { ScoringModule } from '../scoring/scoring.module';
import { StudentSyncService } from './student-sync.service';
import { SyncController } from './sync.controller';
import { SyncQueueService } from './sync.queue';
import { SyncScheduler } from './sync.scheduler';
import { SyncService } from './sync.service';

@Module({
  imports: [ScoringModule, AuthModule, CampusesModule],
  controllers: [SyncController],
  providers: [SyncService, StudentSyncService, SyncQueueService, SyncScheduler],
  exports: [SyncService, StudentSyncService],
})
export class SyncModule {}
