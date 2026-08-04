import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { CONFIG_TOKEN, loadConfiguration, type AppConfig } from './config/configuration';
import { ProgramTimeService } from './common/services/program-time.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';

import { PrismaModule } from './infra/prisma/prisma.module';
import { CacheModule } from './infra/cache/cache.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { StudentsModule } from './modules/students/students.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { SyncModule } from './modules/sync/sync.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { LeaderboardModule } from './modules/leaderboard/leaderboard.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InternalModule } from './modules/internal/internal.module';

/**
 * Typed configuration and the program clock, available everywhere without an import.
 *
 * Both are genuinely cross-cutting: almost every service needs one or the other, and
 * `ProgramTimeService` in particular must be the *only* way day boundaries are derived.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG_TOKEN, useFactory: (): AppConfig => loadConfiguration() },
    ProgramTimeService,
  ],
  exports: [CONFIG_TOKEN, ProgramTimeService],
})
class CoreModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ScheduleModule.forRoot(),

    // Global rate limit. Auth routes tighten this further with @Throttle.
    ThrottlerModule.forRoot([
      {
        ttl: Number.parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10) * 1000,
        limit: Number.parseInt(process.env.THROTTLE_LIMIT ?? '300', 10),
      },
    ]),

    CoreModule,
    PrismaModule,
    CacheModule,
    ProvidersModule,
    AuditModule,

    AuthModule,
    StudentsModule,
    AssignmentsModule,
    ScoringModule,
    SyncModule,
    DashboardModule,
    LeaderboardModule,
    AnalyticsModule,
    ReportsModule,
    AdminModule,
    NotificationsModule,
    HealthModule,
    InternalModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: authenticate, then authorize, then rate-limit.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
