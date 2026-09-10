import type { TradingMode } from "./trading_mode";


export interface TradingConfig {

  // How many simultaneous positions Ciel can hold
  maxPositions: number;

  // Minimum Gemini confidence required
  minimumConfidence: number;

  // Maximum percentage of total portfolio exposed
  maxPortfolioExposurePct: number;

  // Maximum percentage allocated to one position
  maxPositionPct: number;

  // Allow earlier entries
  allowAccumulationEntries: boolean;

  // Emergency stop system
  circuitBreakerEnabled: boolean;

  // Maximum failed operations before pausing
  maxFailuresBeforePause: number;
}


export const TRADING_CONFIG: Record<TradingMode, TradingConfig> = {

  /*
   * Research mode.
   *
   * Purpose:
   * - collect data
   * - test strategies
   * - allow Ciel to make more decisions
   *
   * Paper mode intentionally has no strategy-level execution limits.
   * Real-money protection belongs to live mode.
   */
  paper: {

    maxPositions: Number.MAX_SAFE_INTEGER,

    minimumConfidence: 0,

    maxPortfolioExposurePct: 100,

    maxPositionPct: 100,

    allowAccumulationEntries: true,

    circuitBreakerEnabled: false,

    maxFailuresBeforePause: Number.MAX_SAFE_INTEGER
  },


  /*
   * Live mode.
   *
   * Entry standards are intentionally relaxed enough to let Ciel
   * trade normal early/mid-stage opportunities while preserving
   * liquidity, exposure, position-size, and circuit-breaker guards.
   */
  live: {

    maxPositions: 10,

    minimumConfidence: 0.48,

    maxPortfolioExposurePct: 60,

    maxPositionPct: 15,

    allowAccumulationEntries: true,

    circuitBreakerEnabled: true,

    maxFailuresBeforePause: 5
  }
};


export function getTradingConfig(
  mode: TradingMode
): TradingConfig {

  return TRADING_CONFIG[mode];
}
