import { defineConfig } from 'vitest/config';

/**
 * Integration suites, run separately from the unit tests.
 *
 * These need a real Postgres (`DATABASE_URL`) because what they verify *is* the database
 * behaviour — composite uniqueness, cascade rules, and the frozen historical batch on
 * `DailyStatus`. Mocking Prisma here would test the mock. They are kept out of
 * `npm test` so the unit suite stays fast and database-free.
 *
 * Each suite creates its own fixtures under a unique prefix and removes them afterwards,
 * so running against a development database leaves no residue.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.e2e-spec.ts'],
    globals: false,
    // Real queries, sequential setup/teardown — well beyond vitest's 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one database; running them in parallel would interleave fixtures.
    fileParallelism: false,
  },
});
