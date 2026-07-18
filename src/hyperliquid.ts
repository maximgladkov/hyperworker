import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { Tenant } from "./config.js";
import type { PositionSide } from "./trail.js";

const PERP_MAX_DECIMALS = 6;
const PERP_MAX_SIG_FIGS = 5;

export interface AssetMeta {
  assetIndex: number;
  szDecimals: number;
}

export interface Position {
  side: PositionSide;
  size: number;
  entryPx: number;
}

export interface RestingStop {
  orderId: number;
  triggerPx: number;
  size: number;
}

export interface OrderResult {
  status: "filled" | "resting";
  oid: number;
  filledSz: number;
  avgPx?: number;
}

export type OrderPricing =
  | { kind: "market"; midPrice: number; maxSlippage: number }
  | { kind: "limit"; limitPx: number };

export function roundSz(value: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.round(value * factor) / factor;
}

export function roundPx(value: number, szDecimals: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Cannot round non-positive price: ${value}`);
  }

  const maxDecimals = Math.max(PERP_MAX_DECIMALS - szDecimals, 0);
  const decimalRounded = Number(value.toFixed(maxDecimals));
  if (Number.isInteger(decimalRounded)) {
    return decimalRounded;
  }

  const magnitude = Math.floor(Math.log10(Math.abs(decimalRounded))) + 1;
  const sigFigDecimals = Math.max(PERP_MAX_SIG_FIGS - magnitude, 0);
  const finalDecimals = Math.min(maxDecimals, sigFigDecimals);
  return Number(decimalRounded.toFixed(finalDecimals));
}

export class HyperliquidClient {
  readonly info: InfoClient;
  private readonly transport: HttpTransport;
  private readonly coin: string;
  private readonly exchangeClients = new Map<string, ExchangeClient>();
  private assetMetaPromise: Promise<AssetMeta> | undefined;

  constructor(hlBase: string, coin: string) {
    this.transport = new HttpTransport({ apiUrl: hlBase });
    this.info = new InfoClient({ transport: this.transport });
    this.coin = coin;
  }

  private exchangeFor(tenant: Tenant): ExchangeClient {
    let client = this.exchangeClients.get(tenant.address);
    if (!client) {
      const wallet = privateKeyToAccount(tenant.agentKey);
      client = new ExchangeClient({ transport: this.transport, wallet });
      this.exchangeClients.set(tenant.address, client);
    }
    return client;
  }

  async getAssetMeta(): Promise<AssetMeta> {
    if (!this.assetMetaPromise) {
      this.assetMetaPromise = this.info.meta().then((meta) => {
        const assetIndex = meta.universe.findIndex((entry) => entry.name === this.coin);
        if (assetIndex === -1) {
          throw new Error(`Coin ${this.coin} not found in Hyperliquid perpetuals universe`);
        }
        const szDecimals = meta.universe[assetIndex]?.szDecimals;
        if (szDecimals === undefined) {
          throw new Error(`Missing szDecimals for coin ${this.coin}`);
        }
        return { assetIndex, szDecimals };
      });
    }
    return this.assetMetaPromise;
  }

  async getMidPrice(): Promise<number> {
    const mids = await this.info.allMids();
    const raw = mids[this.coin];
    if (raw !== undefined) {
      return Number(raw);
    }

    const book = await this.info.l2Book({ coin: this.coin });
    const bestBid = book?.levels[0]?.[0]?.px;
    const bestAsk = book?.levels[1]?.[0]?.px;
    if (!bestBid || !bestAsk) {
      throw new Error(`Unable to determine mid price for ${this.coin}: no mids and no L2 book levels`);
    }
    return (Number(bestBid) + Number(bestAsk)) / 2;
  }

  async getPosition(address: `0x${string}`): Promise<Position | null> {
    const state = await this.info.clearinghouseState({ user: address });
    const entry = state.assetPositions.find((p) => p.position.coin === this.coin);
    if (!entry) return null;

    const szi = Number(entry.position.szi);
    if (szi === 0) return null;

    return {
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      entryPx: Number(entry.position.entryPx),
    };
  }

  async getRestingStop(address: `0x${string}`, positionSide: PositionSide): Promise<RestingStop | null> {
    const wantSide = positionSide === "long" ? "A" : "B";
    return this.findRestingStop(address, (order) => order.side === wantSide);
  }

  async getAnyRestingStop(address: `0x${string}`): Promise<RestingStop | null> {
    return this.findRestingStop(address, () => true);
  }

  private async findRestingStop(
    address: `0x${string}`,
    matchesSide: (order: { side: "B" | "A" }) => boolean,
  ): Promise<RestingStop | null> {
    const orders = await this.info.frontendOpenOrders({ user: address });
    const stop = orders.find(
      (order) =>
        order.coin === this.coin &&
        order.reduceOnly &&
        order.isTrigger &&
        order.orderType === "Stop Market" &&
        matchesSide(order),
    );
    if (!stop) return null;

    return {
      orderId: stop.oid,
      triggerPx: Number(stop.triggerPx),
      size: Number(stop.sz),
    };
  }

  async placeStop(
    tenant: Tenant,
    positionSide: PositionSide,
    size: number,
    triggerPx: number,
  ): Promise<number> {
    const { assetIndex, szDecimals } = await this.getAssetMeta();
    const exchange = this.exchangeFor(tenant);
    const isBuy = positionSide === "short";
    const px = roundPx(triggerPx, szDecimals);
    const sz = roundSz(size, szDecimals);

    const result = await exchange.order({
      orders: [
        {
          a: assetIndex,
          b: isBuy,
          p: String(px),
          s: String(sz),
          r: true,
          t: { trigger: { isMarket: true, triggerPx: String(px), tpsl: "sl" } },
        },
      ],
      grouping: "na",
    });

    const status = result.response.data.statuses[0];
    if (!status || typeof status !== "object") {
      throw new Error(`Unexpected order placement response: ${JSON.stringify(result)}`);
    }
    if ("error" in status) {
      throw new Error(`Order placement failed: ${status.error}`);
    }
    if ("resting" in status) {
      return status.resting.oid;
    }
    if ("filled" in status) {
      return status.filled.oid;
    }
    throw new Error(`Order placement did not result in a resting order: ${JSON.stringify(status)}`);
  }

  async placeOrder(
    tenant: Tenant,
    isBuy: boolean,
    size: number,
    reduceOnly: boolean,
    pricing: OrderPricing,
  ): Promise<OrderResult> {
    const { assetIndex, szDecimals } = await this.getAssetMeta();
    const exchange = this.exchangeFor(tenant);
    const sz = roundSz(size, szDecimals);
    if (sz <= 0) {
      throw new Error(`Order size rounds to zero at ${szDecimals} decimals: ${size}`);
    }

    let rawPx: number;
    let tif: "Ioc" | "Gtc";
    if (pricing.kind === "limit") {
      rawPx = pricing.limitPx;
      tif = "Gtc";
    } else {
      rawPx = isBuy
        ? pricing.midPrice * (1 + pricing.maxSlippage)
        : pricing.midPrice * (1 - pricing.maxSlippage);
      tif = "Ioc";
    }
    const px = roundPx(rawPx, szDecimals);

    const result = await exchange.order({
      orders: [
        {
          a: assetIndex,
          b: isBuy,
          p: String(px),
          s: String(sz),
          r: reduceOnly,
          t: { limit: { tif } },
        },
      ],
      grouping: "na",
    });

    const status = result.response.data.statuses[0];
    if (!status || typeof status !== "object") {
      throw new Error(`Unexpected order response: ${JSON.stringify(result)}`);
    }
    if ("error" in status) {
      throw new Error(`Order failed: ${status.error}`);
    }
    if ("filled" in status) {
      return {
        status: "filled",
        oid: status.filled.oid,
        filledSz: Number(status.filled.totalSz),
        avgPx: Number(status.filled.avgPx),
      };
    }
    if ("resting" in status) {
      return { status: "resting", oid: status.resting.oid, filledSz: 0 };
    }
    throw new Error(`Order returned an unrecognized status: ${JSON.stringify(status)}`);
  }

  async modifyStop(
    tenant: Tenant,
    positionSide: PositionSide,
    orderId: number,
    size: number,
    triggerPx: number,
  ): Promise<void> {
    const { assetIndex, szDecimals } = await this.getAssetMeta();
    const exchange = this.exchangeFor(tenant);
    const isBuy = positionSide === "short";
    const px = roundPx(triggerPx, szDecimals);
    const sz = roundSz(size, szDecimals);

    await exchange.modify({
      oid: orderId,
      order: {
        a: assetIndex,
        b: isBuy,
        p: String(px),
        s: String(sz),
        r: true,
        t: { trigger: { isMarket: true, triggerPx: String(px), tpsl: "sl" } },
      },
    });
  }

  async cancelOrder(tenant: Tenant, orderId: number): Promise<void> {
    const { assetIndex } = await this.getAssetMeta();
    const exchange = this.exchangeFor(tenant);
    await exchange.cancel({ cancels: [{ a: assetIndex, o: orderId }] });
  }
}
