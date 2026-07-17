import type { Tenant } from "./config.js";
import { HyperliquidClient, type Position, type RestingStop } from "./hyperliquid.js";
import { tenantLogger, type Logger } from "./logger.js";
import { alertError, alertPositionClosed, alertPositionOpened, alertStopMoved } from "./notify.js";
import { RedisCoordinator } from "./redis.js";
import type { TenantState } from "./state.js";
import { candidateStop, isTighter } from "./trail.js";

const SIZE_DRIFT_EPSILON = 1e-8;

function sizeDrifted(current: number, actual: number): boolean {
  return Math.abs(current - actual) > SIZE_DRIFT_EPSILON;
}

export class TenantEngine {
  private readonly log: Logger;
  private hadPosition = false;

  constructor(
    private readonly hl: HyperliquidClient,
    private readonly redis: RedisCoordinator,
    private readonly coin: string,
    private readonly tenant: Tenant,
  ) {
    this.log = tenantLogger(tenant.address);
  }

  async reconcile(): Promise<void> {
    const position = await this.hl.getPosition(this.tenant.address);
    this.hadPosition = position !== null;

    if (!position) {
      const stray = await this.hl.getAnyRestingStop(this.tenant.address);
      if (stray) {
        await this.hl.cancelOrder(this.tenant, stray.orderId);
        this.log.warn({ orderId: stray.orderId }, "startup: canceled stray stop-loss with no open position");
      } else {
        this.log.info("startup: no open position");
      }
      return;
    }

    const resting = await this.hl.getRestingStop(this.tenant.address, position.side);
    if (resting) {
      this.log.info(
        { orderId: resting.orderId, triggerPx: resting.triggerPx },
        "startup: adopted existing stop-loss",
      );
      return;
    }

    const price = await this.hl.getMidPrice();
    const stopPx = candidateStop(position.side, price, this.tenant.trail);
    const orderId = await this.hl.placeStop(this.tenant, position.side, position.size, stopPx);
    this.log.warn({ orderId, triggerPx: stopPx }, "startup: created missing stop-loss for open position");
  }

  async run(price: number): Promise<void> {
    try {
      const position = await this.hl.getPosition(this.tenant.address);
      if (!position) {
        await this.runFlat(price);
      } else {
        await this.runOpen(price, position);
      }
    } catch (error) {
      alertError(this.log, error);
      throw error;
    }
  }

  private async runFlat(price: number): Promise<void> {
    let lastAction = "idle: no open position";

    const stray = await this.hl.getAnyRestingStop(this.tenant.address);
    if (stray) {
      await this.hl.cancelOrder(this.tenant, stray.orderId);
      lastAction = `canceled stray stop-loss ${stray.orderId}`;
      this.log.warn({ orderId: stray.orderId }, lastAction);
    }

    if (this.hadPosition) {
      alertPositionClosed(this.log);
    }
    this.hadPosition = false;

    await this.publish(price, null, null, lastAction);
  }

  private async runOpen(price: number, position: Position): Promise<void> {
    if (!this.hadPosition) {
      alertPositionOpened(this.log, position.side, position.size);
    }
    this.hadPosition = true;

    const candidate = candidateStop(position.side, price, this.tenant.trail);
    let resting = await this.hl.getRestingStop(this.tenant.address, position.side);
    let lastAction = "holding: stop unchanged";

    if (!resting) {
      const orderId = await this.hl.placeStop(this.tenant, position.side, position.size, candidate);
      lastAction = `created stop at ${candidate}`;
      this.log.warn({ orderId, triggerPx: candidate }, lastAction);
      resting = { orderId, triggerPx: candidate, size: position.size };
    } else {
      if (sizeDrifted(resting.size, position.size)) {
        await this.hl.modifyStop(this.tenant, position.side, resting.orderId, position.size, resting.triggerPx);
        lastAction = `resized stop to ${position.size}`;
        this.log.info({ orderId: resting.orderId, size: position.size }, lastAction);
        resting = { ...resting, size: position.size };
      }

      if (isTighter(position.side, candidate, resting.triggerPx)) {
        const from = resting.triggerPx;
        await this.hl.modifyStop(this.tenant, position.side, resting.orderId, position.size, candidate);
        lastAction = `moved stop ${from} -> ${candidate}`;
        alertStopMoved(this.log, from, candidate);
        resting = { ...resting, triggerPx: candidate };
      }
    }

    await this.publish(price, position, resting, lastAction);
  }

  private async publish(
    price: number,
    position: Position | null,
    stop: RestingStop | null,
    lastAction: string,
  ): Promise<void> {
    const state: TenantState = {
      address: this.tenant.address,
      coin: this.coin,
      price,
      position: position ? { side: position.side, size: position.size, entryPx: position.entryPx } : null,
      stop: stop ? { triggerPx: stop.triggerPx, orderId: stop.orderId } : null,
      trail: { type: this.tenant.trail.type, value: this.tenant.trail.value },
      lastAction,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.publishState(state);
  }
}
