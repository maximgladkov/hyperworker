import webpush from "web-push";
import { logger, type Logger } from "./logger.js";
import type { RedisCoordinator } from "./redis.js";
import type { PositionSide } from "./trail.js";

let configured = false;

export function initPush(): boolean {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();

  if (!subject || !publicKey || !privateKey) {
    logger.warn("VAPID keys not fully configured; position-closed push notifications disabled");
    configured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  logger.info("web-push configured; position-closed notifications enabled");
  return true;
}

function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

export async function notifyPositionClosed(
  redis: RedisCoordinator,
  log: Logger,
  address: string,
  coin: string,
  side: PositionSide,
  pnl: number,
): Promise<void> {
  if (!configured) return;

  const subs = await redis.getPushSubs(address);
  const endpoints = Object.entries(subs);
  if (endpoints.length === 0) return;

  const payload = JSON.stringify({
    title: `${coin} position closed`,
    body: `${side === "long" ? "Long" : "Short"} closed · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
    url: "/",
    tag: `${address}:${coin}:close`,
  });

  await Promise.all(
    endpoints.map(async ([endpoint, json]) => {
      try {
        await webpush.sendNotification(JSON.parse(json), payload);
      } catch (error) {
        const statusCode = statusCodeOf(error);
        if (statusCode === 404 || statusCode === 410) {
          await redis.deletePushSub(address, endpoint);
          log.info({ endpoint }, "pruned stale push subscription");
        } else {
          log.error({ err: error, endpoint, statusCode }, "push send failed");
        }
      }
    }),
  );
}
