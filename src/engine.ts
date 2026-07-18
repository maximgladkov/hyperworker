import { isValidTrail, type Tenant, type TrailConfig } from "./config.js";
import { HyperliquidClient, type Position, type RestingStop } from "./hyperliquid.js";
import { tenantLogger, type Logger } from "./logger.js";
import { alertError, alertPositionClosed, alertPositionOpened, alertStopMoved } from "./notify.js";
import { notifyPositionClosed } from "./push.js";
import { RedisCoordinator } from "./redis.js";
import type { TenantState } from "./state.js";
import { candidateStop, isTighter } from "./trail.js";

const SIZE_DRIFT_EPSILON = 1e-8;

function sizeDrifted(current: number, actual: number): boolean {
  return Math.abs(current - actual) > SIZE_DRIFT_EPSILON;
}

function estimatePnl(position: Position, exitPrice: number): number {
  const diff = position.side === "long" ? exitPrice - position.entryPx : position.entryPx - exitPrice;
  return diff * position.size;
}

function trailChanged(a: TrailConfig | undefined, b: TrailConfig): boolean {
  return a !== undefined && (a.type !== b.type || a.value !== b.value);
}

export class TenantEngine {
  private readonly log: Logger;
  private hadPosition = false;
  private lastPosition: Position | null = null;
  private lastTrail: TrailConfig | undefined;

  constructor(
    private readonly hl: HyperliquidClient,
    private readonly redis: RedisCoordinator,
    private readonly coin: string,
    private readonly tenant: Tenant,
  ) {
    this.log = tenantLogger(tenant.address);
  }

  private async resolveTrail(): Promise<{ trail: TrailConfig; enabled: boolean }> {
    const override = await this.redis.getTenantConfig(this.tenant.address);
    const enabled = override.enabled ?? true;

    if (override.type === undefined && override.value === undefined) {
      return { trail: this.tenant.trail, enabled };
    }

    const merged: TrailConfig = {
      type: override.type ?? this.tenant.trail.type,
      value: override.value ?? this.tenant.trail.value,
    };

    if (!isValidTrail(merged)) {
      this.log.warn(
        { override, fallback: this.tenant.trail },
        "invalid trail override in redis; falling back to configured default",
      );
      return { trail: this.tenant.trail, enabled };
    }

    return { trail: merged, enabled };
  }

  async reconcile(): Promise<void> {
    const position = await this.hl.getPosition(this.tenant.address);
    this.hadPosition = position !== null;
    this.lastPosition = position;

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

    const { trail, enabled } = await this.resolveTrail();

    if (!enabled) {
      const resting = await this.hl.getAnyRestingStop(this.tenant.address);
      if (resting) {
        await this.hl.cancelOrder(this.tenant, resting.orderId);
        this.log.warn({ orderId: resting.orderId }, "startup: trail disabled, canceled resting stop-loss");
      } else {
        this.log.info("startup: trail disabled, no stop to cancel");
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
    const stopPx = candidateStop(position.side, price, trail);
    const orderId = await this.hl.placeStop(this.tenant, position.side, position.size, stopPx);
    this.log.warn({ orderId, triggerPx: stopPx }, "startup: created missing stop-loss for open position");
  }

  async run(price: number): Promise<void> {
    try {
      const position = await this.hl.getPosition(this.tenant.address);
      const { trail, enabled } = await this.resolveTrail();
      if (!position) {
        await this.runFlat(price, trail, enabled);
      } else {
        await this.runOpen(price, position, trail, enabled);
      }
    } catch (error) {
      alertError(this.log, error);
      throw error;
    }
  }

  private async runFlat(price: number, trail: TrailConfig, enabled: boolean): Promise<void> {
    let lastAction = "idle: no open position";

    const stray = await this.hl.getAnyRestingStop(this.tenant.address);
    if (stray) {
      await this.hl.cancelOrder(this.tenant, stray.orderId);
      lastAction = `canceled stray stop-loss ${stray.orderId}`;
      this.log.warn({ orderId: stray.orderId }, lastAction);
    }

    if (this.hadPosition) {
      alertPositionClosed(this.log);
      const closed = this.lastPosition;
      if (closed) {
        const pnl = estimatePnl(closed, price);
        await notifyPositionClosed(
          this.redis,
          this.log,
          this.tenant.address,
          this.coin,
          closed.side,
          closed.size,
          price,
          pnl,
        );
      }
    }
    this.hadPosition = false;
    this.lastPosition = null;
    this.lastTrail = undefined;

    await this.publish(price, null, null, lastAction, trail, enabled);
  }

  private async runOpen(
    price: number,
    position: Position,
    trail: TrailConfig,
    enabled: boolean,
  ): Promise<void> {
    if (!this.hadPosition) {
      alertPositionOpened(this.log, position.side, position.size);
    }
    this.hadPosition = true;
    this.lastPosition = position;

    if (!enabled) {
      let lastAction = "holding: trail disabled";
      const resting = await this.hl.getAnyRestingStop(this.tenant.address);
      if (resting) {
        await this.hl.cancelOrder(this.tenant, resting.orderId);
        lastAction = `trail disabled: canceled stop ${resting.orderId}`;
        this.log.warn({ orderId: resting.orderId }, lastAction);
      }
      this.lastTrail = undefined;
      await this.publish(price, position, null, lastAction, trail, enabled);
      return;
    }

    const candidate = candidateStop(position.side, price, trail);
    const reconfigured = trailChanged(this.lastTrail, trail);
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

      const shouldMove = reconfigured
        ? candidate !== resting.triggerPx
        : isTighter(position.side, candidate, resting.triggerPx);

      if (shouldMove) {
        const from = resting.triggerPx;
        await this.hl.modifyStop(this.tenant, position.side, resting.orderId, position.size, candidate);
        lastAction = reconfigured
          ? `reconfigured stop ${from} -> ${candidate}`
          : `moved stop ${from} -> ${candidate}`;
        alertStopMoved(this.log, from, candidate);
        resting = { ...resting, triggerPx: candidate };
      }
    }

    this.lastTrail = trail;
    await this.publish(price, position, resting, lastAction, trail, enabled);
  }

  private async publish(
    price: number,
    position: Position | null,
    stop: RestingStop | null,
    lastAction: string,
    trail: TrailConfig,
    enabled: boolean,
  ): Promise<void> {
    const state: TenantState = {
      address: this.tenant.address,
      coin: this.coin,
      price,
      position: position ? { side: position.side, size: position.size, entryPx: position.entryPx } : null,
      stop: stop ? { triggerPx: stop.triggerPx, orderId: stop.orderId } : null,
      trail: { type: trail.type, value: trail.value, enabled },
      lastAction,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.publishState(state);
  }
}
