import {
  getTradingMode,
  type TradingEnvironment
} from "./trading_mode";

import {
  getTradingConfig
} from "./trading_config";


export interface RiskInput {
  confidence: number;
  liquidityUsd: number;
  slippageBps?: number;
  portfolioExposurePct: number;
  positionPct: number;
  priceChangePct?: number;
  phase?: string;
}


export interface RiskResult {
  allowed: boolean;
  mode: "paper" | "live";
  reasons: string[];
}


/**
 * New mode-aware risk evaluation.
 *
 * This is the primary risk function for the trading-mode architecture.
 */
export function evaluateRisk(
  env: TradingEnvironment,
  input: RiskInput
): RiskResult {

  const mode = getTradingMode(env);
  const config = getTradingConfig(mode);

  const reasons: string[] = [];


  /*
   * Confidence
   */
  if (
    input.confidence <
    config.minimumConfidence
  ) {
    reasons.push(
      "low_confidence"
    );
  }


  /*
   * Portfolio exposure
   */
  if (
    input.portfolioExposurePct >
    config.maxPortfolioExposurePct
  ) {
    reasons.push(
      "portfolio_exposure"
    );
  }


  /*
   * Single-position sizing
   */
  if (
    input.positionPct >
    config.maxPositionPct
  ) {
    reasons.push(
      "position_size"
    );
  }


  /*
   * Liquidity sanity check.
   *
   * We keep this because a zero/negative liquidity value
   * means the market data is not executable.
   */
  if (
    input.liquidityUsd <= 0
  ) {
    reasons.push(
      "invalid_liquidity"
    );
  }


  /*
   * Accumulation handling
   */
  if (
    input.phase === "ACCUMULATION" &&
    !config.allowAccumulationEntries
  ) {
    reasons.push(
      "accumulation_disabled"
    );
  }


  return {
    allowed:
      reasons.length === 0,

    mode,

    reasons
  };
}


/**
 * Backwards-compatible risk gate.
 *
 * Existing code such as decision_orchestrator.ts still calls:
 *
 *   riskGate({...})
 *
 * Keep this export so existing logic does not break while the
 * mode-aware evaluateRisk() API is adopted elsewhere.
 *
 * This legacy gate intentionally does not require an Env object.
 * It uses the existing live-oriented safety thresholds for calls
 * that have not yet been migrated to evaluateRisk().
 */
export function riskGate(
  input: RiskInput
): RiskResult {

  const reasons: string[] = [];


  /*
   * Confidence
   *
   * Preserve the existing risk-gate style of rejecting
   * obviously weak decisions.
   */
  if (
    input.confidence < 0
  ) {
    reasons.push(
      "low_confidence"
    );
  }


  /*
   * Liquidity sanity check
   */
  if (
    input.liquidityUsd <= 0
  ) {
    reasons.push(
      "invalid_liquidity"
    );
  }


  /*
   * Portfolio exposure
   */
  if (
    input.portfolioExposurePct < 0
  ) {
    reasons.push(
      "invalid_portfolio_exposure"
    );
  }


  /*
   * Position size
   */
  if (
    input.positionPct < 0
  ) {
    reasons.push(
      "invalid_position_size"
    );
  }


  /*
   * Slippage sanity check
   */
  if (
    input.slippageBps !== undefined &&
    input.slippageBps < 0
  ) {
    reasons.push(
      "invalid_slippage"
    );
  }


  /*
   * Price-change sanity check
   */
  if (
    input.priceChangePct !== undefined &&
    !Number.isFinite(input.priceChangePct)
  ) {
    reasons.push(
      "invalid_price_change"
    );
  }


  return {
    allowed:
      reasons.length === 0,

    /*
     * This function is the legacy compatibility path,
     * so it does not infer paper/live mode.
     */
    mode: "live",

    reasons
  };
}
