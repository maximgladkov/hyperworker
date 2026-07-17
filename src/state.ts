import type { TrailType } from "./config.js";
import type { PositionSide } from "./trail.js";

export interface PositionState {
  side: PositionSide;
  size: number;
  entryPx: number;
}

export interface StopState {
  triggerPx: number;
  orderId: number;
}

export interface TrailState {
  type: TrailType;
  value: number;
}

export interface TenantState {
  address: string;
  coin: string;
  price: number;
  position: PositionState | null;
  stop: StopState | null;
  trail: TrailState;
  lastAction: string;
  updatedAt: string;
}
