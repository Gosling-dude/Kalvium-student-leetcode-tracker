import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma client lifecycle.
 *
 * Connects eagerly at boot so a bad `DATABASE_URL` surfaces during startup rather than
 * on the first mentor request, and disconnects cleanly on shutdown so containers stop
 * without leaking pooled connections.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    // Prisma's typed event emitter does not narrow well through the base class;
    // the casts keep the handlers readable without weakening anything at runtime.
    (this as unknown as { $on: (e: string, cb: (v: { message: string }) => void) => void }).$on(
      'warn',
      (event) => this.logger.warn(event.message),
    );
    (this as unknown as { $on: (e: string, cb: (v: { message: string }) => void) => void }).$on(
      'error',
      (event) => this.logger.error(event.message),
    );

    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Delete every row, respecting foreign keys. Test-support only — refuses to run
   * against a production database, because "reset the database" is exactly the kind
   * of helper that eventually gets called somewhere it shouldn't.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('truncateAll() must never run in production');
    }

    const tables = await this.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
    `;

    if (tables.length === 0) return;

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
  }
}
