import { analyzeMarketPattern, type MarketPatternInput } from "./pattern_engine";

export type MarketIntelligence = {
  symbol: string;
  marketCap: number;
  momentum30m: number;
  momentum2h: number;
  volumeTrend: "increasing" | "flat" | "decreasing";
  liquidityHealth: "healthy" | "weak";
  buyPressure: number;
  sellPressure: number;
  marketPhase: "ACCUMULATION" | "EXPANSION" | "DISTRIBUTION" | "DEATH";
  lifecyclePhase: "BASE" | "BREAKOUT" | "EXPANSION" | "PEAK" | "RETRACE" | "SECONDARY_EXPANSION" | "DISTRIBUTION" | "DEATH";
  trendStructure: "HH_HL" | "HH_LL" | "LH_HL" | "LH_LL" | "FLAT" | "UNKNOWN";
  waveCount: number;
  currentWave: number;
  firstExpansionMultiple: number;
  retracementPct: number;
  secondExpansionMultiple: number;
  volumeExpansionRatio: number;
  volumeDecayRatio: number;
  liquidityChangeSincePeakPct: number;
  breakoutQuality: number;
  retracementQuality: number;
  blowOffRisk: number;
  distributionRisk: number;
  deathRisk: number;
  entryScore: number;
  exitRisk: number;
};

export function buildMarketIntelligence(input: {
  symbol: string;
  marketCap: number;
  snapshots: Array<{
    marketCapUsd: number;
    volumeUsd: number;
    liquidityUsd: number;
    buys?: number;
    sells?: number;
  }>;
}): MarketIntelligence {
  const latest = input.snapshots[0] || {
    marketCapUsd: input.marketCap,
    volumeUsd: 0,
    liquidityUsd: 0,
    buys: 0,
    sells: 0
  };
  const previous = input.snapshots[1];
  const momentum30m = previous?.marketCapUsd
    ? ((latest.marketCapUsd - previous.marketCapUsd) / previous.marketCapUsd) * 100
    : 0;
  const previous2h = input.snapshots[Math.min(23, input.snapshots.length - 1)];
  const momentum2h = previous2h?.marketCapUsd
    ? ((latest.marketCapUsd - previous2h.marketCapUsd) / previous2h.marketCapUsd) * 100
    : 0;
  const patternInput: MarketPatternInput = {
    marketCapUsd: latest.marketCapUsd,
    previousMarketCapUsd: input.snapshots
      .slice(1)
      .map(s => s.marketCapUsd)
      .reverse(),
    volumeUsd: latest.volumeUsd,
    previousVolumeUsd: input.snapshots
      .slice(1)
      .map(s => s.volumeUsd)
      .reverse(),
    liquidityUsd: latest.liquidityUsd,
    previousLiquidityUsd: input.snapshots
      .slice(1)
      .map(s => s.liquidityUsd)
      .reverse(),
    buys: latest.buys,
    sells: latest.sells
  };
  const pattern = analyzeMarketPattern(patternInput);
  const total = (latest.buys || 0) + (latest.sells || 0);
  const buyPressure = total ? (latest.buys || 0) / total : 0.5;
  return {
    symbol: input.symbol,
    marketCap: input.marketCap,
    momentum30m,
    momentum2h,
    volumeTrend: latest.volumeUsd > (previous?.volumeUsd || latest.volumeUsd)
      ? "increasing"
      : latest.volumeUsd < (previous?.volumeUsd || latest.volumeUsd)
        ? "decreasing"
        : "flat",
    liquidityHealth: latest.liquidityUsd >= 10000 ? "healthy" : "weak",
    buyPressure,
    sellPressure: 1 - buyPressure,
    marketPhase: pattern.phase,
    lifecyclePhase: pattern.lifecyclePhase,
    trendStructure: pattern.trendStructure,
    waveCount: pattern.waveCount,
    currentWave: pattern.currentWave,
    firstExpansionMultiple: pattern.firstExpansionMultiple,
    retracementPct: pattern.retracementPct,
    secondExpansionMultiple: pattern.secondExpansionMultiple,
    volumeExpansionRatio: pattern.volumeExpansionRatio,
    volumeDecayRatio: pattern.volumeDecayRatio,
    liquidityChangeSincePeakPct: pattern.liquidityChangeSincePeakPct,
    breakoutQuality: pattern.breakoutQuality,
    retracementQuality: pattern.retracementQuality,
    blowOffRisk: pattern.blowOffRisk,
    distributionRisk: pattern.distributionRisk,
    deathRisk: pattern.deathRisk,
    entryScore: pattern.entryScore,
    exitRisk: pattern.exitScore
  };
}

export function compressForGemini(items: MarketIntelligence[]) {
  return items.slice(0, 3).map(i => ({
    symbol: i.symbol,
    marketCap: i.marketCap,
    momentum30m: i.momentum30m,
    momentum2h: i.momentum2h,
    volumeTrend: i.volumeTrend,
    liquidityHealth: i.liquidityHealth,
    phase: i.marketPhase,
    lifecyclePhase: i.lifecyclePhase,
    trendStructure: i.trendStructure,
    waveCount: i.waveCount,
    currentWave: i.currentWave,
    firstExpansionMultiple: Number(i.firstExpansionMultiple.toFixed(2)),
    retracementPct: Number(i.retracementPct.toFixed(2)),
    secondExpansionMultiple: Number(i.secondExpansionMultiple.toFixed(2)),
    volumeExpansionRatio: Number(i.volumeExpansionRatio.toFixed(2)),
    volumeDecayRatio: Number(i.volumeDecayRatio.toFixed(2)),
    liquidityChangeSincePeakPct: Number(i.liquidityChangeSincePeakPct.toFixed(2)),
    breakoutQuality: Number(i.breakoutQuality.toFixed(3)),
    retracementQuality: Number(i.retracementQuality.toFixed(3)),
    blowOffRisk: Number(i.blowOffRisk.toFixed(3)),
    distributionRisk: Number(i.distributionRisk.toFixed(3)),
    deathRisk: Number(i.deathRisk.toFixed(3)),
    buyPressure: Number(i.buyPressure.toFixed(3)),
    entryScore: i.entryScore,
    exitRisk: i.exitRisk
  }));
}
