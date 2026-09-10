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

  portfolioExposurePct: number;

  positionPct: number;

  phase?: string;

}


export interface RiskResult {

  allowed: boolean;

  mode: "paper" | "live";

  reasons: string[];

}



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
   * Position count/exposure
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
   * Single trade sizing
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
   * Liquidity check stays.
   *
   * This is NOT a trading restriction.
   * It prevents garbage execution.
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
