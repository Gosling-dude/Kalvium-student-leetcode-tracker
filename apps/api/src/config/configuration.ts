/**
 * Typed application configuration.
 *
 * Every environment variable is read exactly once, here, and validated at boot. A
 * misconfigured deployment should fail immediately and loudly rather than at 09:00
 * when a sync silently writes submissions into the wrong day.
 */

import { DEFAULT_PROGRAM_TIMEZONE, DEFAULT_PROBLEMS_PER_DAY, PROVIDER_LIMITS } from '@dsa/shared';

export type QueueDriver = 'bullmq' | 'inline';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  swaggerEnabled: boolean;

  database: { url: string };

  redis: {
    url: string;
    prefix: string;
    /** `inline` runs sync work in-process, removing the Redis requirement. */
    driver: QueueDriver;
  };

  cache: { enabled: boolean };

  auth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
    bcryptRounds: number;
  };

  seed: { adminEmail: string; adminPassword: string; adminName: string };

  program: {
    /** Every day boundary in the application resolves in this zone. */
    timezone: string;
    problemsPerDay: number;
  };

  sync: { cron: string; enabled: boolean; rollupCron: string };

  provider: {
    endpoint: string;
    requestsPerSecond: number;
    concurrency: number;
    maxRetries: number;
    timeoutMs: number;
    sessionCookie: string | null;
    csrfToken: string | null;
  };

  throttle: { ttlSeconds: number; limit: number };

  logging: { level: string; pretty: boolean; persist: boolean };
}

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function toList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Fails fast if the configured timezone is not one the runtime actually knows. */
function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error(
      `PROGRAM_TIMEZONE "${timezone}" is not a valid IANA timezone. ` +
        `Every streak and daily report depends on this value being correct.`,
    );
  }
}

export function loadConfiguration(): AppConfig {
  const env = (process.env.NODE_ENV ?? 'development') as AppConfig['env'];
  const isProduction = env === 'production';

  const accessSecret = requireEnv(
    'JWT_ACCESS_SECRET',
    isProduction ? undefined : 'dev-only-access-secret-not-for-production-use',
  );
  const refreshSecret = requireEnv(
    'JWT_REFRESH_SECRET',
    isProduction ? undefined : 'dev-only-refresh-secret-not-for-production-use',
  );

  // Weak secrets in production are a deployment bug, not a warning.
  if (isProduction) {
    for (const [name, secret] of [
      ['JWT_ACCESS_SECRET', accessSecret],
      ['JWT_REFRESH_SECRET', refreshSecret],
    ] as const) {
      if (secret.length < 32) {
        throw new Error(`${name} must be at least 32 characters in production.`);
      }
      if (secret.includes('change-me') || secret.includes('dev-only')) {
        throw new Error(`${name} still holds its placeholder value. Generate a real secret.`);
      }
    }
  }

  if (accessSecret === refreshSecret) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ, otherwise an access ' +
        'token can be replayed as a refresh token.',
    );
  }

  const driver = (process.env.QUEUE_DRIVER ?? 'bullmq').toLowerCase();
  if (driver !== 'bullmq' && driver !== 'inline') {
    throw new Error(`QUEUE_DRIVER must be "bullmq" or "inline", received "${driver}".`);
  }

  return {
    env,
    port: toInt(process.env.PORT, 4000),
    apiPrefix: process.env.API_PREFIX ?? 'api/v1',
    corsOrigins: toList(process.env.CORS_ORIGINS, ['http://localhost:3000']),
    swaggerEnabled: toBool(process.env.SWAGGER_ENABLED, !isProduction),

    database: {
      url: requireEnv(
        'DATABASE_URL',
        isProduction
          ? undefined
          : 'postgresql://dsa:dsa_password@localhost:5432/dsa_tracker?schema=public',
      ),
    },

    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      prefix: process.env.REDIS_PREFIX ?? 'dsa',
      driver: driver as QueueDriver,
    },

    cache: { enabled: toBool(process.env.CACHE_ENABLED, true) },

    auth: {
      accessSecret,
      refreshSecret,
      accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
      refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
      bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
    },

    seed: {
      adminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@kalvium.com',
      adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026',
      adminName: process.env.SEED_ADMIN_NAME ?? 'Program Admin',
    },

    program: {
      timezone: validateTimezone(process.env.PROGRAM_TIMEZONE ?? DEFAULT_PROGRAM_TIMEZONE),
      problemsPerDay: toInt(process.env.PROBLEMS_PER_DAY, DEFAULT_PROBLEMS_PER_DAY),
    },

    sync: {
      cron: process.env.SYNC_CRON ?? '0 */3 * * *',
      enabled: toBool(process.env.SYNC_ENABLED, true),
      rollupCron: process.env.ROLLUP_CRON ?? '30 0 * * *',
    },

    provider: {
      endpoint: process.env.LEETCODE_GRAPHQL_ENDPOINT ?? 'https://leetcode.com/graphql',
      requestsPerSecond: toFloat(
        process.env.PROVIDER_REQUESTS_PER_SECOND,
        PROVIDER_LIMITS.requestsPerSecond,
      ),
      concurrency: toInt(process.env.PROVIDER_CONCURRENCY, PROVIDER_LIMITS.concurrency),
      maxRetries: toInt(process.env.PROVIDER_MAX_RETRIES, PROVIDER_LIMITS.maxRetries),
      timeoutMs: toInt(process.env.PROVIDER_TIMEOUT_MS, PROVIDER_LIMITS.requestTimeoutMs),
      sessionCookie: process.env.LEETCODE_SESSION_COOKIE || null,
      csrfToken: process.env.LEETCODE_CSRF_TOKEN || null,
    },

    throttle: {
      ttlSeconds: toInt(process.env.THROTTLE_TTL_SECONDS, 60),
      limit: toInt(process.env.THROTTLE_LIMIT, 300),
    },

    logging: {
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: toBool(process.env.LOG_PRETTY, !isProduction),
      persist: toBool(process.env.PERSIST_LOGS, true),
    },
  };
}

export const CONFIG_TOKEN = 'APP_CONFIG';
