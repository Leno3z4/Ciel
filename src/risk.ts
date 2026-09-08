import { config } from "./config";

export interface RiskInput {
  confidence: number;
  liquidityUsd: number;
  slippageBps: number;
  portfolioExposurePct: number;
  positionPct: number;
  priceChangePct: number;
}

export function riskGate(input: RiskInput) {
  const reasons: string[] = [];
  if (input.confidence < config.risk.minimumSignalConfidence) reasons.push("confidence below threshold");
  if (input.liquidityUsd < config.risk.minimumLiquidityUsd) reasons.push("insufficient liquidity");
  if (input.slippageBps > config.risk.maxSlippageBps) reasons.push("slippage too high");
  if (input.portfolioExposurePct > config.risk.maxPortfolioExposurePct) reasons.push("portfolio exposure limit");
  if (input.positionPct > config.risk.maxPositionPct) reasons.push("position size limit");
  if (input.priceChangePct <= -config.risk.emergencyDropPct) reasons.push("emergency price drop");
  return { allowed: reasons.length === 0, reasons };
}
