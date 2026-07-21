import type { Tenant } from "./config.js";
import type { TenantEngine } from "./engine.js";
import type { HyperliquidClient, OpenOrder, OrderResult } from "./hyperliquid.js";
import { logger } from "./logger.js";

export type OrderSide = "buy" | "sell";

export interface PlaceOrderRequest {
  side: OrderSide;
  size: number;
  reduceOnly?: boolean;
  price?: number;
}

export interface CloseResult {
  closed: boolean;
  reason?: string;
  order?: OrderResult;
}

export interface CancelResult {
  canceled: boolean;
  oid: number;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class UnknownTenantError extends Error {
  constructor(address: string) {
    super(`No tenant configured for address ${address}`);
    this.name = "UnknownTenantError";
  }
}

export class TradeService {
  private readonly tenants = new Map<string, Tenant>();
  private readonly locks = new Map<string, Mutex>();
  private readonly engines = new Map<string, TenantEngine>();

  constructor(
    private readonly hl: HyperliquidClient,
    tenants: Tenant[],
    engines: TenantEngine[],
    private readonly maxSlippage: number,
  ) {
    for (let i = 0; i < tenants.length; i++) {
      const tenant = tenants[i]!;
      const engine = engines[i]!;
      this.tenants.set(tenant.address, tenant);
      this.locks.set(tenant.address, new Mutex());
      this.engines.set(tenant.address, engine);
    }
  }

  private resolve(address: string): { tenant: Tenant; lock: Mutex; engine: TenantEngine } {
    const key = address.toLowerCase();
    const tenant = this.tenants.get(key);
    const lock = this.locks.get(key);
    const engine = this.engines.get(key);
    if (!tenant || !lock || !engine) {
      throw new UnknownTenantError(address);
    }
    return { tenant, lock, engine };
  }

  async runEngine(address: string, price: number): Promise<void> {
    const { lock, engine } = this.resolve(address);
    return lock.run(() => engine.run(price));
  }

  async placeOrder(address: string, request: PlaceOrderRequest): Promise<OrderResult> {
    const { tenant, lock, engine } = this.resolve(address);
    const reduceOnly = request.reduceOnly ?? false;
    const isBuy = request.side === "buy";

    return lock.run(async () => {
      const log = logger.child({ address: tenant.address });

      if (request.price !== undefined) {
        log.warn(
          { side: request.side, size: request.size, reduceOnly, limitPx: request.price },
          "manual limit order requested",
        );
        const result = await this.hl.placeOrder(tenant, isBuy, request.size, reduceOnly, {
          kind: "limit",
          limitPx: request.price,
        });
        log.warn({ result }, "manual limit order submitted");
        if (result.status === "filled" && result.avgPx !== undefined) {
          log.warn({ avgPx: result.avgPx }, "order filled; resetting trailing stop from fill price");
          await engine.run(result.avgPx);
        }
        return result;
      }

      const midPrice = await this.hl.getMidPrice();
      log.warn(
        { side: request.side, size: request.size, reduceOnly, midPrice },
        "manual market order requested",
      );
      const result = await this.hl.placeOrder(tenant, isBuy, request.size, reduceOnly, {
        kind: "market",
        midPrice,
        maxSlippage: this.maxSlippage,
      });
      log.warn({ result }, "manual market order submitted");
      if (result.status === "filled" && result.avgPx !== undefined) {
        log.warn({ avgPx: result.avgPx }, "order filled; resetting trailing stop from fill price");
        await engine.run(result.avgPx);
      }
      return result;
    });
  }

  async listOrders(address: string): Promise<OpenOrder[]> {
    const { tenant, lock } = this.resolve(address);
    return lock.run(() => this.hl.getOpenOrders(tenant.address));
  }

  async cancelOrder(address: string, oid: number): Promise<CancelResult> {
    const { tenant, lock } = this.resolve(address);

    return lock.run(async () => {
      const log = logger.child({ address: tenant.address });
      log.warn({ oid }, "manual order cancel requested");
      await this.hl.cancelOrder(tenant, oid);
      log.warn({ oid }, "manual order cancel submitted");
      return { canceled: true, oid };
    });
  }

  async closePosition(address: string): Promise<CloseResult> {
    const { tenant, lock } = this.resolve(address);

    return lock.run(async () => {
      const position = await this.hl.getPosition(tenant.address);
      if (!position) {
        return { closed: false, reason: "no open position" };
      }

      const midPrice = await this.hl.getMidPrice();
      const isBuy = position.side === "short";
      const log = logger.child({ address: tenant.address });
      log.warn({ position, midPrice }, "manual close requested");
      const order = await this.hl.placeOrder(tenant, isBuy, position.size, true, {
        kind: "market",
        midPrice,
        maxSlippage: this.maxSlippage,
      });
      log.warn({ order }, "manual close submitted");
      return { closed: true, order };
    });
  }
}
