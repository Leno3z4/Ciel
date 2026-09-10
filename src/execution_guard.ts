import {
  getTradingMode,
  type TradingEnvironment
} from "./trading_mode";

import {
  getTradingConfig
} from "./trading_config";


export interface ExecutionRequest {

  confidence: number;

  openPositions: number;

  currentExposurePct: number;

  requestedPositionPct: number;

  phase?: string;

  liquidityUsd?: number;
}


export interface ExecutionDecision {

  allowed: boolean;

  mode: "paper" | "live";

  reasons: string[];
}


export function checkExecutionAllowed(
  env: TradingEnvironment,
  request: ExecutionRequest
): ExecutionDecision {


  const mode = getTradingMode(env);

  const config = getTradingConfig(mode);


  const reasons: string[] = [];



  /*
   * Confidence check
   */
  if (
    request.confidence <
    config.minimumConfidence
  ) {

    reasons.push(
      "confidence_below_threshold"
    );

  }



  /*
   * Position count check
   */
  if (
    request.openPositions >=
    config.maxPositions
  ) {

    reasons.push(
      "maximum_positions_reached"
    );

  }



  /*
   * Portfolio exposure check
   */
  if (
    request.currentExposurePct >
    config.maxPortfolioExposurePct
  ) {

    reasons.push(
      "portfolio_exposure_limit"
    );

  }



  /*
   * Single position sizing check
   */
  if (
    request.requestedPositionPct >
    config.maxPositionPct
  ) {

    reasons.push(
      "position_size_limit"
    );

  }



  /*
   * Accumulation handling
   */
  if (
    request.phase === "ACCUMULATION" &&
    !config.allowAccumulationEntries
  ) {

    reasons.push(
      "accumulation_entries_disabled"
    );

  }



  return {

    allowed:
      reasons.length === 0,

    mode,

    reasons

  };

}
