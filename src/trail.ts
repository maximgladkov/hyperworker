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
