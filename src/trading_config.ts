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
   * This is NOT real-money protection.
   */
  paper: {

    maxPositions: 50,

    minimumConfidence: 0.50,

    maxPortfolioExposurePct: 100,

    maxPositionPct: 25,

    allowAccumulationEntries: true,

    circuitBreakerEnabled: false,

    maxFailuresBeforePause: 20
  },


  /*
   * Live mode.
   *
   * Still flexible, but protects capital.
   *
   * These are intentionally not ultra-conservative.
   */
  live: {

    maxPositions: 10,

    minimumConfidence: 0.60,

    maxPortfolioExposurePct: 50,

    maxPositionPct: 10,

    allowAccumulationEntries: false,

    circuitBreakerEnabled: true,

    maxFailuresBeforePause: 5
  }
};


export function getTradingConfig(
  mode: TradingMode
): TradingConfig {

  return TRADING_CONFIG[mode];
}
