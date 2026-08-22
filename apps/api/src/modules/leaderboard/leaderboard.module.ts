import { Module } from '@nestjs/common';
import { BatchesModule } from '../batches/batches.module';
import { CampusesModule } from '../campuses/campuses.module';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';

@Module({
  imports: [BatchesModule, CampusesModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
