import { loadConfig } from "./config.js";
import { TenantEngine } from "./engine.js";
import { pingHealthcheck } from "./health.js";
import { HyperliquidClient } from "./hyperliquid.js";
import { logger } from "./logger.js";
import { RedisCoordinator } from "./redis.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    { coin: config.coin, hlBase: config.hlBase, pollMs: config.pollMs, tenantCount: config.tenants.length },
    "starting hyperworker",
  );

  const hl = new HyperliquidClient(config.hlBase, config.coin);
  const redis = new RedisCoordinator(config);

  const acquired = await redis.acquireLock();
  if (!acquired) {
    logger.error("another instance already holds bot:lock; refusing to start a second singleton");
    process.exit(1);
    return;
  }

  const engines = config.tenants.map((tenant) => new TenantEngine(hl, redis, config.coin, tenant));

  for (const engine of engines) {
    await engine.reconcile();
  }
  logger.info({ tenantCount: engines.length }, "startup reconciliation complete");

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let currentIteration: Promise<void> = Promise.resolve();

  async function runIteration(): Promise<void> {
    let loopOk = true;

    try {
      const renewed = await redis.renewLock();
      if (!renewed) {
        logger.error("lost bot:lock ownership; another instance may now be active. Exiting for safety.");
        stopped = true;
        process.exit(1);
        return;
      }

      const price = await hl.getMidPrice();

      for (const engine of engines) {
        try {
          await engine.run(price);
        } catch (error) {
          loopOk = false;
          logger.error(
            { err: error },
            "tenant iteration failed; previous stop order remains resting, retrying next loop",
          );
        }
      }
    } catch (error) {
      loopOk = false;
      logger.error({ err: error }, "loop iteration failed");
    }

    await pingHealthcheck(config.healthcheckUrl, loopOk);
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      currentIteration = runIteration();
      currentIteration.finally(scheduleNext).catch(() => {});
    }, config.pollMs);
  }

  currentIteration = runIteration();
  currentIteration.finally(scheduleNext).catch(() => {});

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logger.info({ signal }, "received shutdown signal, finishing in-flight loop iteration");
    if (timer) clearTimeout(timer);
    await currentIteration.catch(() => {});
    await redis.releaseLock();
    logger.info("released singleton lock, exiting");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error({ err: error }, "fatal error during startup");
  process.exit(1);
});
