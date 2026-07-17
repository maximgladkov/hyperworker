import type { Logger } from "./logger.js";

export function alertStopMoved(logger: Logger, from: number, to: number): void {
  logger.warn({ event: "stop_moved", from, to }, `moved stop ${from} -> ${to}`);
}

export function alertPositionOpened(logger: Logger, side: string, size: number): void {
  logger.warn({ event: "position_opened", side, size }, "position opened");
}

export function alertPositionClosed(logger: Logger): void {
  logger.warn({ event: "position_closed" }, "position closed");
}

export function alertError(logger: Logger, error: unknown): void {
  logger.error({ event: "error", err: error }, "iteration error");
}
