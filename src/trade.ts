import type { Tenant } from "./config.js";
import type { HyperliquidClient, MarketOrderResult } from "./hyperliquid.js";
import { logger } from "./logger.js";

export type OrderSide = "buy" | "sell";

export interface PlaceOrderRequest {
  side: OrderSide;
  size: number;
  reduceOnly?: boolean;
}

export interface CloseResult {
  closed: boolean;
  reason?: string;
  order?: MarketOrderResult;
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

  constructor(
    private readonly hl: HyperliquidClient,
    tenants: Tenant[],
    private readonly maxSlippage: number,
  ) {
    for (const tenant of tenants) {
      this.tenants.set(tenant.address, tenant);
      this.locks.set(tenant.address, new Mutex());
    }
  }

  private resolve(address: string): { tenant: Tenant; lock: Mutex } {
    const key = address.toLowerCase();
    const tenant = this.tenants.get(key);
    const lock = this.locks.get(key);
    if (!tenant || !lock) {
      throw new UnknownTenantError(address);
    }
    return { tenant, lock };
  }

  async placeOrder(address: string, request: PlaceOrderRequest): Promise<MarketOrderResult> {
    const { tenant, lock } = this.resolve(address);
    const reduceOnly = request.reduceOnly ?? false;
    const isBuy = request.side === "buy";

    return lock.run(async () => {
      const price = await this.hl.getMidPrice();
      const log = logger.child({ address: tenant.address });
      log.warn(
        { side: request.side, size: request.size, reduceOnly, price },
        "manual order requested",
      );
      const result = await this.hl.placeMarketOrder(
        tenant,
        isBuy,
        request.size,
        reduceOnly,
        price,
        this.maxSlippage,
      );
      log.warn({ result }, "manual order submitted");
      return result;
    });
  }

  async closePosition(address: string): Promise<CloseResult> {
    const { tenant, lock } = this.resolve(address);

    return lock.run(async () => {
      const position = await this.hl.getPosition(tenant.address);
      if (!position) {
        return { closed: false, reason: "no open position" };
      }

      const price = await this.hl.getMidPrice();
      const isBuy = position.side === "short";
      const log = logger.child({ address: tenant.address });
      log.warn({ position, price }, "manual close requested");
      const order = await this.hl.placeMarketOrder(
        tenant,
        isBuy,
        position.size,
        true,
        price,
        this.maxSlippage,
      );
      log.warn({ order }, "manual close submitted");
      return { closed: true, order };
    });
  }
}
