import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "hyperworker" },
});

export function tenantLogger(address: string) {
  return logger.child({ address });
}

export type Logger = typeof logger;
