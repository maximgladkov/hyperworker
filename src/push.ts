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
    logger.warn("VAPID keys not fully configured; position push notifications disabled");
    configured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  logger.info("web-push configured; position open/modify/close notifications enabled");
  return true;
}

function statusCodeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "statusCode" in error) {
    const code = (error as { statusCode?: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function formatPrice(price: number): string {
  return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

async function sendToSubs(
  redis: RedisCoordinator,
  log: Logger,
  address: string,
  payload: string,
): Promise<void> {
  if (!configured) return;

  const subs = await redis.getPushSubs(address);
  const endpoints = Object.entries(subs);
  if (endpoints.length === 0) return;

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

export async function notifyPositionOpened(
  redis: RedisCoordinator,
  log: Logger,
  address: string,
  coin: string,
  side: PositionSide,
  size: number,
  entryPx: number,
): Promise<void> {
  const payload = JSON.stringify({
    title: `${side.toUpperCase()} OPENED`,
    body: `${size} ${coin} @ $${formatPrice(entryPx)}`,
    url: "/",
    tag: `${address}:${coin}:open`,
  });
  await sendToSubs(redis, log, address, payload);
}

export async function notifyPositionModified(
  redis: RedisCoordinator,
  log: Logger,
  address: string,
  coin: string,
  side: PositionSide,
  previousSize: number,
  size: number,
  entryPx: number,
): Promise<void> {
  const payload = JSON.stringify({
    title: `${side.toUpperCase()} MODIFIED`,
    body: `${previousSize} -> ${size} ${coin} @ $${formatPrice(entryPx)}`,
    url: "/",
    tag: `${address}:${coin}:modify`,
  });
  await sendToSubs(redis, log, address, payload);
}

export async function notifyPositionClosed(
  redis: RedisCoordinator,
  log: Logger,
  address: string,
  coin: string,
  side: PositionSide,
  size: number,
  exitPrice: number,
  pnl: number,
): Promise<void> {
  const pnlFmt = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  const payload = JSON.stringify({
    title: `${side.toUpperCase()} CLOSED`,
    body: `${size} ${coin} @ $${formatPrice(exitPrice)} (${pnlFmt})`,
    url: "/",
    tag: `${address}:${coin}:close`,
  });
  await sendToSubs(redis, log, address, payload);
}
