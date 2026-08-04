import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Decorator metadata is not needed by these suites — they cover pure units
    // (rate limiting, retry policy, the provider contract via the fake) rather than
    // Nest's DI container, which keeps them fast and database-free.
    globals: false,
  },
});
