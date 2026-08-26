/**
 * Typed application configuration.
 *
 * Every environment variable is read exactly once, here, and validated at boot. A
 * misconfigured deployment should fail immediately and loudly rather than at 09:00
 * when a sync silently writes submissions into the wrong day.
 */

import {
  DEFAULT_PROGRAM_TIMEZONE,
  DEFAULT_PROBLEMS_PER_DAY,
  PROVIDER_LIMITS,
  passwordPolicyViolation,
} from '@dsa/shared';

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

  seed: {
    adminEmail: string;
    adminPassword: string;
    adminName: string;
    /**
     * One shared initial password for newly provisioned student logins.
     *
     * `null` — the default — keeps the safer behaviour: every student gets their own
     * CSPRNG password. Setting it is a deliberate operational trade-off (one password to
     * read out to a room of 250) and is only safe because an unchanged initial password
     * cannot actually be used: `ForcePasswordChangeGuard` blocks every route but the one
     * that changes it, so knowing the shared value gets an attacker to a change-password
     * form and nowhere else.
     *
     * Never stored, never logged, never returned. It is hashed per account like any other
     * password, with each account getting its own bcrypt salt.
     */
    studentPassword: string | null;
  };

  program: {
    /** Every day boundary in the application resolves in this zone. */
    timezone: string;
    problemsPerDay: number;
  };

  sync: { cron: string; enabled: boolean; rollupCron: string };

  /**
   * Shared secret for the internal cron endpoints (`/internal/sync`, `/internal/rollup`).
   * These are triggered by GitHub Actions instead of an in-process scheduler, so they
   * are reachable without a user session and must be gated by a bearer secret. `null`
   * means the endpoints reject every request (fail closed).
   */
  cron: { secret: string | null };

  /**
   * Shared secret for the admin deployment-secret password-recovery endpoint
   * (`/admin-recovery/deployment-secret`). Same fail-closed model as `cron.secret`:
   * `null` means the endpoint rejects every request. This is the recovery path that
   * doesn't depend on `email` being configured.
   */
  adminRecovery: { secret: string | null };

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

  /**
   * Outbound email for the daily report feature (`EmailService`). `provider: 'none'`
   * (the default when `EMAIL_API_KEY` is unset) means previews, drafts and the
   * approval workflow all work — only the final `send` call fails, with a clear error
   * rather than silently no-opping. See docs/DAILY_EMAIL_REPORTING.md.
   */
  email: {
    provider: 'resend' | 'none';
    apiKey: string | null;
    fromEmail: string | null;
    /** Default recipients the daily-report GitHub Action uses when nobody has set any. */
    defaultTo: string[];
    defaultCc: string[];
    /**
     * Override for the provider's API endpoint. Unset in production, where the transport
     * uses the provider's own URL. Exists so the real send path — transport, HTTP,
     * response parsing, error mapping — can be exercised end to end against a local
     * stub, instead of being the one code path that only ever runs in production.
     */
    apiBaseUrl: string | null;
  };
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

  // One shared initial password for student logins, if the programme has chosen to use
  // one. Validated here rather than at the point of use: this value is applied to every
  // student account provisioned from now on, so "it was too weak" has to surface at boot
  // — when one person can still fix it — not after 250 accounts already carry it.
  const seedStudentPassword = process.env.SEED_STUDENT_PASSWORD?.trim() || null;
  if (seedStudentPassword) {
    const violation = passwordPolicyViolation(seedStudentPassword);
    if (violation) {
      // The value itself is never echoed, here or anywhere else.
      throw new Error(`SEED_STUDENT_PASSWORD does not satisfy the password policy: it ${violation}.`);
    }
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
      studentPassword: seedStudentPassword,
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

    cron: { secret: process.env.CRON_SECRET || null },

    adminRecovery: { secret: process.env.ADMIN_RECOVERY_SECRET || null },

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

    email: {
      provider: (process.env.EMAIL_PROVIDER ?? 'none') as 'resend' | 'none',
      apiKey: process.env.EMAIL_API_KEY || null,
      fromEmail: process.env.EMAIL_FROM || null,
      defaultTo: toList(process.env.EMAIL_DEFAULT_TO, []),
      defaultCc: toList(process.env.EMAIL_DEFAULT_CC, []),
      apiBaseUrl: process.env.EMAIL_API_BASE_URL || null,
    },
  };
}

export const CONFIG_TOKEN = 'APP_CONFIG';
