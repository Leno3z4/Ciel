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
  if (input.confidence < 0.72) reasons.push("confidence below threshold");
  if (input.liquidityUsd < 10_000) reasons.push("insufficient liquidity");
  if (input.slippageBps > 500) reasons.push("slippage too high");
  if (input.portfolioExposurePct > 25) reasons.push("portfolio exposure limit");
  if (input.positionPct > 5) reasons.push("position size limit");
  if (input.priceChangePct <= -15) reasons.push("emergency price drop");
  return { allowed: reasons.length === 0, reasons };
}
