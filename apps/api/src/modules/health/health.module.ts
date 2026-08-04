import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators';
import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Liveness: is the process up? Deliberately dependency-free. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Readiness: can we actually serve traffic? */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — checks database and cache' })
  async ready() {
    const checks: Record<string, { status: 'up' | 'down'; detail?: string }> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'up' };
    } catch (error) {
      checks.database = { status: 'down', detail: (error as Error).message };
    }

    // A degraded cache is not a readiness failure: the service falls back to memory
    // and keeps serving, just more slowly.
    checks.cache = {
      status: 'up',
      detail: this.cache.isRedisHealthy ? 'redis' : 'in-memory fallback',
    };

    const ready = checks.database?.status === 'up';
    return {
      status: ready ? 'ok' : 'degraded',
      checks,
      programTimezone: this.time.timezone,
      today: this.time.today(),
      queueDriver: this.config.redis.driver,
    };
  }

  /**
   * Provider reachability. Separate from readiness because LeetCode being down should
   * not take this service out of a load balancer — cached reports still work.
   */
  @Public()
  @Get('provider')
  @ApiOperation({ summary: 'Data-provider reachability' })
  async providerHealth() {
    const healthy = await this.provider.healthCheck();
    return { provider: this.provider.name, status: healthy ? 'up' : 'down' };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
