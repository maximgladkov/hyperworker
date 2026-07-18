import { serve, type ServerType } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { type TradeService, UnknownTenantError } from "./trade.js";

const orderBodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  size: z.number().finite().positive(),
  reduceOnly: z.boolean().optional(),
});

export function startServer(config: AppConfig, trade: TradeService): ServerType {
  const app = new Hono();

  app.use("*", cors({ origin: config.corsOrigin }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    if (config.apiAuthToken) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token !== config.apiAuthToken) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    return next();
  });

  app.post("/api/tenants/:address/order", async (c) => {
    const address = c.req.param("address");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const parsed = orderBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid request", details: parsed.error.issues }, 400);
    }

    try {
      const result = await trade.placeOrder(address, parsed.data);
      return c.json({ ok: true, order: result });
    } catch (error) {
      return handleTradeError(c, error, address);
    }
  });

  app.post("/api/tenants/:address/close", async (c) => {
    const address = c.req.param("address");
    try {
      const result = await trade.closePosition(address);
      return c.json({ ok: true, ...result });
    } catch (error) {
      return handleTradeError(c, error, address);
    }
  });

  const server = serve({ fetch: app.fetch, port: config.port });
  logger.info({ port: config.port }, "trading API listening");
  if (!config.apiAuthToken) {
    logger.warn(
      "API_AUTH_TOKEN is not set: the trading API is UNAUTHENTICATED and will place real orders for any address it is given. Set API_AUTH_TOKEN before exposing this publicly.",
    );
  }
  return server;
}

function handleTradeError(c: Context, error: unknown, address: string) {
  if (error instanceof UnknownTenantError) {
    return c.json({ error: error.message }, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ err: error, address }, "trade request failed");
  return c.json({ error: message }, 500);
}
