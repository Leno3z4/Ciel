export type CandidateContext = {
  symbol: string;
  marketCap: number;
  momentum30m: number;
  momentum2h: number;
  volumeTrend: string;
  liquidityHealth: string;
  buyPressure: number;
  phase: string;
  entryScore: number;
  exitRisk: number;
  timeScore: number;
};

export function buildGeminiContext(candidates: CandidateContext[]): CandidateContext[] {
  return [...candidates]
    .sort((a, b) => b.entryScore - a.entryScore)
    .slice(0, 3)
    .map(candidate => ({
      symbol: candidate.symbol,
      marketCap: candidate.marketCap,
      momentum30m: candidate.momentum30m,
      momentum2h: candidate.momentum2h,
      volumeTrend: candidate.volumeTrend,
      liquidityHealth: candidate.liquidityHealth,
      buyPressure: candidate.buyPressure,
      phase: candidate.phase,
      entryScore: candidate.entryScore,
      exitRisk: candidate.exitRisk,
      timeScore: candidate.timeScore
    }));
}

export function emergencyDecision(context: CandidateContext[]): { action: "BUY" | "WAIT"; reason: string } {
  const best = context[0];
  if (!best) return { action: "WAIT", reason: "no candidates" };
  if (best.phase === "DEATH" || best.exitRisk > 80) {
    return { action: "WAIT", reason: "risk filter blocked candidate" };
  }
  if (best.entryScore >= 85 && best.buyPressure >= 0.6) {
    return { action: "BUY", reason: "local emergency rules passed" };
  }
  return { action: "WAIT", reason: "insufficient confidence" };
}
