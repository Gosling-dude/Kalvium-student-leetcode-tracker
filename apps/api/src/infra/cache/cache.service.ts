/**
 * Cache with automatic degradation.
 *
 * Redis when it is reachable, an in-process LRU when it is not. The fallback is not a
 * convenience for local development — it is a resilience property: a Redis outage
 * should slow the dashboard down, not take the platform offline in front of a mentor.
 *
 * Connection loss is handled by flipping to memory and retrying in the background, so
 * recovery needs no restart.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

/** Bounded so a degraded node cannot exhaust heap while Redis is down. */
const MEMORY_CACHE_MAX_ENTRIES = 5_000;

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private redisHealthy = false;
  private readonly memory = new Map<string, MemoryEntry>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    // Expired-entry sweep for the memory tier. Redis does this itself.
    this.sweeper = setInterval(() => this.sweepMemory(), 60_000);
    this.sweeper.unref?.();

    if (!this.config.cache.enabled) {
      this.logger.log('Cache disabled by configuration');
      return;
    }

    try {
      this.redis = new Redis(this.config.redis.url, {
        keyPrefix: `${this.config.redis.prefix}:cache:`,
        maxRetriesPerRequest: 2,
        // Fail fast at boot instead of blocking startup on an unreachable Redis.
        connectTimeout: 3_000,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 500, 10_000),
      });

      this.redis.on('error', (error) => {
        if (this.redisHealthy) {
          this.logger.warn(`Redis error, falling back to in-memory cache: ${error.message}`);
        }
        this.redisHealthy = false;
      });
      this.redis.on('ready', () => {
        this.redisHealthy = true;
        this.logger.log('Redis cache connected');
      });

      await this.redis.connect();
      this.redisHealthy = true;
    } catch (error) {
      this.logger.warn(
        `Redis unavailable (${(error as Error).message}). Using in-memory cache; ` +
          'this is safe for a single instance but is not shared across replicas.',
      );
      this.redisHealthy = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.redis) {
      this.redis.disconnect();
      this.redis = null;
    }
  }

  get isRedisHealthy(): boolean {
    return this.redisHealthy;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.config.cache.enabled) return null;

    if (this.redis && this.redisHealthy) {
      try {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch (error) {
        this.logger.debug(`Redis GET failed for "${key}": ${(error as Error).message}`);
        this.redisHealthy = false;
      }
    }

    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.config.cache.enabled) return;

    const serialised = JSON.stringify(value);

    if (this.redis && this.redisHealthy) {
      try {
        await this.redis.set(key, serialised, 'EX', ttlSeconds);
        return;
      } catch (error) {
        this.logger.debug(`Redis SET failed for "${key}": ${(error as Error).message}`);
        this.redisHealthy = false;
      }
    }

    // Simple LRU-ish eviction: Map preserves insertion order, so the first key is
    // the oldest write.
    if (this.memory.size >= MEMORY_CACHE_MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, { value: serialised, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /** Read-through helper: the shape almost every caller actually wants. */
  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  async del(key: string): Promise<void> {
    this.memory.delete(key);
    if (this.redis && this.redisHealthy) {
      try {
        await this.redis.del(key);
      } catch {
        this.redisHealthy = false;
      }
    }
  }

  /**
   * Invalidate by prefix — used after a sync, when every dashboard, leaderboard and
   * analytics figure for a day becomes stale at once.
   *
   * Uses SCAN rather than KEYS: KEYS blocks the Redis event loop, and at production
   * key counts that is a self-inflicted outage.
   */
  async delByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }

    if (!this.redis || !this.redisHealthy) return;

    try {
      const fullPrefix = `${this.config.redis.prefix}:cache:${prefix}`;
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${fullPrefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          // Keys from SCAN include the prefix that ioredis would add again, so
          // delete through a prefix-free command.
          await this.redis.call('DEL', ...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.logger.debug(`Redis prefix invalidation failed: ${(error as Error).message}`);
      this.redisHealthy = false;
    }
  }

  async flush(): Promise<void> {
    this.memory.clear();
    await this.delByPrefix('');
  }

  private sweepMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
  }
}
