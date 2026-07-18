import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { type AppConfig, parseTrailOverride, type TrailOverride } from "./config.js";
import { logger } from "./logger.js";
import type { TenantState } from "./state.js";

const LOCK_KEY = "bot:lock";
const LOCK_TTL_MS = 30_000;
const TENANTS_KEY = "bot:tenants";
const UPDATES_CHANNEL = "bot:updates";
const CONFIG_KEY_PREFIX = "bot:config:";
const PUSH_SUBS_KEY_PREFIX = "push:subs:";

function fingerprint(state: TenantState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}

export class RedisCoordinator {
  private readonly redis: Redis;
  private readonly lockId = randomUUID();
  private readonly lastFingerprint = new Map<string, string>();

  constructor(config: AppConfig) {
    this.redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.on("error", (error) => {
      logger.error({ err: error }, "redis connection error");
    });
  }

  async acquireLock(): Promise<boolean> {
    const result = await this.redis.set(LOCK_KEY, this.lockId, "PX", LOCK_TTL_MS, "NX");
    return result === "OK";
  }

  async renewLock(): Promise<boolean> {
    const current = await this.redis.get(LOCK_KEY);
    if (current !== this.lockId) return false;
    await this.redis.set(LOCK_KEY, this.lockId, "PX", LOCK_TTL_MS, "XX");
    return true;
  }

  async releaseLock(): Promise<void> {
    const current = await this.redis.get(LOCK_KEY);
    if (current === this.lockId) {
      await this.redis.del(LOCK_KEY);
    }
  }

  async getTenantConfig(address: string): Promise<TrailOverride> {
    const raw = await this.redis.hgetall(`${CONFIG_KEY_PREFIX}${address}`);
    return parseTrailOverride(raw);
  }

  async getPushSubs(address: string): Promise<Record<string, string>> {
    return this.redis.hgetall(`${PUSH_SUBS_KEY_PREFIX}${address}`);
  }

  async deletePushSub(address: string, endpoint: string): Promise<void> {
    await this.redis.hdel(`${PUSH_SUBS_KEY_PREFIX}${address}`, endpoint);
  }

  async publishState(state: TenantState): Promise<void> {
    await this.redis.set(`bot:state:${state.address}`, JSON.stringify(state));
    await this.redis.sadd(TENANTS_KEY, state.address);

    const nextFingerprint = fingerprint(state);
    if (this.lastFingerprint.get(state.address) !== nextFingerprint) {
      await this.redis.publish(UPDATES_CHANNEL, JSON.stringify(state));
      this.lastFingerprint.set(state.address, nextFingerprint);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
