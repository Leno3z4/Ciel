export type MarketPatternInput = {
  marketCapUsd: number;
  previousMarketCapUsd?: number[];
  volumeUsd: number;
  previousVolumeUsd?: number[];
  liquidityUsd: number;
  buys?: number;
  sells?: number;
  hourUtc?: number;
};

export type MarketPatternScore = {
  phase: "ACCUMULATION" | "EXPANSION" | "DISTRIBUTION" | "DEATH";
  entryScore: number;
  exitScore: number;
  reasons: string[];
};

export function analyzeMarketPattern(input: MarketPatternInput): MarketPatternScore {
  const reasons: string[] = [];
  const caps = input.previousMarketCapUsd || [];
  const volumes = input.previousVolumeUsd || [];
  const previousCap = caps.length ? caps[caps.length - 1] : input.marketCapUsd;
  const previousVolume = volumes.length ? volumes[volumes.length - 1] : input.volumeUsd;

  const capChange = previousCap > 0 ? ((input.marketCapUsd - previousCap) / previousCap) * 100 : 0;
  const volumeAcceleration = previousVolume > 0 ? input.volumeUsd / previousVolume : 1;
  const buyRatio = ((input.buys || 0) + (input.sells || 0)) > 0
    ? (input.buys || 0) / ((input.buys || 0) + (input.sells || 0))
    : 0.5;

  let entryScore = 0;
  let exitScore = 0;

  if (volumeAcceleration > 1.5) {
    entryScore += 25;
    reasons.push("volume acceleration");
  }
  if (capChange > 0 && capChange < 15) {
    entryScore += 20;
    reasons.push("healthy upward movement");
  }
  if (buyRatio > 0.6) {
    entryScore += 20;
    reasons.push("buy pressure");
  }
  if (capChange < -10) {
    exitScore += 35;
    reasons.push("market cap decline");
  }
  if (buyRatio < 0.4) {
    exitScore += 25;
    reasons.push("sell pressure");
  }

  let phase: MarketPatternScore["phase"] = "ACCUMULATION";
  if (exitScore > entryScore && capChange < -5) phase = "DISTRIBUTION";
  else if (entryScore > 50 && capChange > 0) phase = "EXPANSION";
  else if (volumeAcceleration < 0.7) phase = "DEATH";

  return {
    phase,
    entryScore: Math.min(100, entryScore),
    exitScore: Math.min(100, exitScore),
    reasons
  };
}
