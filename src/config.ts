import { z } from "zod";

export type TrailType = "pct" | "abs";

export interface TrailConfig {
  type: TrailType;
  value: number;
}

export interface TrailOverride {
  type?: TrailType;
  value?: number;
  enabled?: boolean;
}

export interface Tenant {
  address: `0x${string}`;
  agentKey: `0x${string}`;
  trail: TrailConfig;
}

export interface AppConfig {
  coin: string;
  hlBase: string;
  pollMs: number;
  redisUrl: string;
  healthcheckUrl: string | undefined;
  tenants: Tenant[];
}

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex-character address");

const privateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 64-hex-character private key");

const trailTypeSchema = z.enum(["pct", "abs"]);

export function isValidTrail(trail: TrailConfig): boolean {
  if (!Number.isFinite(trail.value) || trail.value <= 0) return false;
  if (trail.type === "pct" && trail.value >= 1) return false;
  return true;
}

function parseBool(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(value)) return true;
  if (["false", "0", "off", "no"].includes(value)) return false;
  return undefined;
}

export function parseTrailOverride(raw: Record<string, string>): TrailOverride {
  const override: TrailOverride = {};

  const type = trailTypeSchema.safeParse(raw.type);
  if (type.success) override.type = type.data;

  if (raw.value !== undefined && raw.value.trim() !== "") {
    const value = Number(raw.value);
    if (Number.isFinite(value) && value > 0) override.value = value;
  }

  if (raw.enabled !== undefined && raw.enabled.trim() !== "") {
    const enabled = parseBool(raw.enabled);
    if (enabled !== undefined) override.enabled = enabled;
  }

  return override;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseGlobalTrailDefault(env: NodeJS.ProcessEnv): TrailConfig | undefined {
  const type = env.TRAIL_TYPE;
  const value = env.TRAIL_VALUE;
  if (!type && !value) return undefined;

  const parsedType = trailTypeSchema.parse(type);
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`TRAIL_VALUE must be a positive number, got: ${value}`);
  }
  return { type: parsedType, value: parsedValue };
}

function parseTenantTrail(
  env: NodeJS.ProcessEnv,
  index: number,
  fallback: TrailConfig | undefined,
): TrailConfig {
  const typeRaw = env[`TRAIL_TYPE_${index}`] ?? fallback?.type;
  const valueRaw = env[`TRAIL_VALUE_${index}`] ?? (fallback ? String(fallback.value) : undefined);

  if (!typeRaw || !valueRaw) {
    throw new Error(
      `Tenant ${index}: missing TRAIL_TYPE_${index}/TRAIL_VALUE_${index} and no global TRAIL_TYPE/TRAIL_VALUE default is configured`,
    );
  }

  const type = trailTypeSchema.parse(typeRaw);
  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Tenant ${index}: TRAIL_VALUE_${index} must be a positive number, got: ${valueRaw}`);
  }
  if (type === "pct" && value >= 1) {
    throw new Error(
      `Tenant ${index}: TRAIL_VALUE_${index} for type "pct" must be a fraction below 1 (e.g. 0.02 = 2%), got: ${value}`,
    );
  }

  return { type, value };
}

function parseTenants(env: NodeJS.ProcessEnv): Tenant[] {
  const globalTrailDefault = parseGlobalTrailDefault(env);
  const tenants: Tenant[] = [];

  for (let index = 1; env[`HL_AGENT_PRIVATE_KEY_${index}`] !== undefined; index++) {
    const addressRaw = requireEnv(env, `HL_ACCOUNT_ADDRESS_${index}`);
    const agentKeyRaw = requireEnv(env, `HL_AGENT_PRIVATE_KEY_${index}`);

    const addressResult = addressSchema.safeParse(addressRaw);
    if (!addressResult.success) {
      throw new Error(`Tenant ${index}: HL_ACCOUNT_ADDRESS_${index} ${addressResult.error.issues[0]?.message}`);
    }
    const agentKeyResult = privateKeySchema.safeParse(agentKeyRaw);
    if (!agentKeyResult.success) {
      throw new Error(`Tenant ${index}: HL_AGENT_PRIVATE_KEY_${index} ${agentKeyResult.error.issues[0]?.message}`);
    }

    const trail = parseTenantTrail(env, index, globalTrailDefault);

    tenants.push({
      address: addressResult.data.toLowerCase() as `0x${string}`,
      agentKey: agentKeyResult.data as `0x${string}`,
      trail,
    });
  }

  if (tenants.length === 0) {
    throw new Error(
      "No tenants configured. Set HL_ACCOUNT_ADDRESS_1 and HL_AGENT_PRIVATE_KEY_1 " +
        "(and optionally TRAIL_TYPE_1/TRAIL_VALUE_1, or global TRAIL_TYPE/TRAIL_VALUE) for at least one tenant.",
    );
  }

  const seen = new Set<string>();
  for (const tenant of tenants) {
    if (seen.has(tenant.address)) {
      throw new Error(`Duplicate tenant address configured: ${tenant.address}`);
    }
    seen.add(tenant.address);
  }

  return tenants;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const coin = requireEnv(env, "COIN");
  const hlBase = requireEnv(env, "HL_BASE");

  const pollMsRaw = env.POLL_MS ?? "3000";
  const pollMs = Number(pollMsRaw);
  if (!Number.isFinite(pollMs) || pollMs < 250) {
    throw new Error(`POLL_MS must be a number >= 250, got: ${pollMsRaw}`);
  }

  const redisUrl = requireEnv(env, "REDIS_URL");
  const healthcheckUrl = env.HEALTHCHECK_URL?.trim() || undefined;

  const tenants = parseTenants(env);

  return { coin, hlBase, pollMs, redisUrl, healthcheckUrl, tenants };
}
