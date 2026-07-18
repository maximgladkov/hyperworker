import type { TrailConfig } from "./config.js";

export type PositionSide = "long" | "short";

export function candidateStop(side: PositionSide, price: number, trail: TrailConfig): number {
  if (trail.type === "pct") {
    return side === "long" ? price * (1 - trail.value) : price * (1 + trail.value);
  }
  return side === "long" ? price - trail.value : price + trail.value;
}

export function isTighter(side: PositionSide, candidate: number, current: number): boolean {
  return side === "long" ? candidate > current : candidate < current;
}

export function impliedPeak(side: PositionSide, stopPx: number, trail: TrailConfig): number {
  if (trail.type === "pct") {
    return side === "long" ? stopPx / (1 - trail.value) : stopPx / (1 + trail.value);
  }
  return side === "long" ? stopPx + trail.value : stopPx - trail.value;
}

export function reconfiguredStop(
  side: PositionSide,
  currentStop: number,
  previous: TrailConfig,
  next: TrailConfig,
  price: number,
): number {
  const peak = impliedPeak(side, currentStop, previous);
  const target = candidateStop(side, peak, next);
  if (side === "long") {
    return target < price ? target : candidateStop(side, price, next);
  }
  return target > price ? target : candidateStop(side, price, next);
}
