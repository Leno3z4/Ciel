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
  entryScore: number;
  exitRisk: number;
};

export function buildMarketIntelligence(input: {
  symbol: string;
  marketCap: number;
  snapshots: Array<{marketCapUsd:number; volumeUsd:number; liquidityUsd:number; buys?:number; sells?:number}>;
}): MarketIntelligence {
  const latest = input.snapshots[0];
  const previous = input.snapshots[1];
  const momentum30m = previous?.marketCapUsd ? ((latest.marketCapUsd - previous.marketCapUsd) / previous.marketCapUsd) * 100 : 0;
  const previous2h = input.snapshots[Math.min(23, input.snapshots.length - 1)];
  const momentum2h = previous2h?.marketCapUsd ? ((latest.marketCapUsd - previous2h.marketCapUsd) / previous2h.marketCapUsd) * 100 : 0;
  const pattern = analyzeMarketPattern({
    marketCapUsd: latest.marketCapUsd,
    previousMarketCapUsd: input.snapshots.map(s => s.marketCapUsd).reverse(),
    volumeUsd: latest.volumeUsd,
    previousVolumeUsd: input.snapshots.map(s => s.volumeUsd).reverse(),
    liquidityUsd: latest.liquidityUsd,
    buys: latest.buys,
    sells: latest.sells
  } as MarketPatternInput);
  const total = (latest.buys || 0) + (latest.sells || 0);
  const buyPressure = total ? (latest.buys || 0) / total : 0.5;
  return {
    symbol: input.symbol,
    marketCap: input.marketCap,
    momentum30m,
    momentum2h,
    volumeTrend: latest.volumeUsd > (previous?.volumeUsd || latest.volumeUsd) ? "increasing" : "flat",
    liquidityHealth: latest.liquidityUsd >= 10000 ? "healthy" : "weak",
    buyPressure,
    sellPressure: 1 - buyPressure,
    marketPhase: pattern.phase,
    entryScore: pattern.entryScore,
    exitRisk: pattern.exitScore
  };
}

export function compressForGemini(items: MarketIntelligence[]) {
  return items.slice(0,3).map(i => ({symbol:i.symbol, marketCap:i.marketCap, momentum30m:i.momentum30m, momentum2h:i.momentum2h, volumeTrend:i.volumeTrend, liquidityHealth:i.liquidityHealth, phase:i.marketPhase, entryScore:i.entryScore, exitRisk:i.exitRisk}));
}
