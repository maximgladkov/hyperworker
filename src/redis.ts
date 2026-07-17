import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { AppConfig } from "./config.js";
import type { TenantState } from "./state.js";

const LOCK_KEY = "bot:lock";
const LOCK_TTL_MS = 30_000;
const TENANTS_KEY = "bot:tenants";
const UPDATES_CHANNEL = "bot:updates";

function fingerprint(state: TenantState): string {
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}

export class RedisCoordinator {
  private readonly redis: Redis;
  private readonly lockId = randomUUID();
  private readonly lastFingerprint = new Map<string, string>();

  constructor(config: AppConfig) {
    this.redis = new Redis({ url: config.upstashUrl, token: config.upstashToken });
  }

  async acquireLock(): Promise<boolean> {
    const result = await this.redis.set(LOCK_KEY, this.lockId, { nx: true, px: LOCK_TTL_MS });
    return result === "OK";
  }

  async renewLock(): Promise<boolean> {
    const current = await this.redis.get<string>(LOCK_KEY);
    if (current !== this.lockId) return false;
    await this.redis.set(LOCK_KEY, this.lockId, { xx: true, px: LOCK_TTL_MS });
    return true;
  }

  async releaseLock(): Promise<void> {
    const current = await this.redis.get<string>(LOCK_KEY);
    if (current === this.lockId) {
      await this.redis.del(LOCK_KEY);
    }
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
}
