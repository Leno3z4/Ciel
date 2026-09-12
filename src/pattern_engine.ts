export type LifecyclePhase =
  | "BASE"
  | "BREAKOUT"
  | "EXPANSION"
  | "PEAK"
  | "RETRACE"
  | "SECONDARY_EXPANSION"
  | "DISTRIBUTION"
  | "DEATH";

export type TrendStructure =
  | "HH_HL"
  | "HH_LL"
  | "LH_HL"
  | "LH_LL"
  | "FLAT"
  | "UNKNOWN";

export type MarketPatternInput = {
  marketCapUsd: number;
  previousMarketCapUsd?: number[];
  volumeUsd: number;
  previousVolumeUsd?: number[];
  liquidityUsd: number;
  previousLiquidityUsd?: number[];
  buys?: number;
  sells?: number;
  hourUtc?: number;
};

export type MarketPatternScore = {
  phase: "ACCUMULATION" | "EXPANSION" | "DISTRIBUTION" | "DEATH";
  lifecyclePhase: LifecyclePhase;
  trendStructure: TrendStructure;
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
  exitScore: number;
  reasons: string[];
};

function pctChange(current: number, previous: number): number {
  return previous > 0
    ? ((current - previous) / previous) * 100
    : 0;
}

function safeRatio(current: number, previous: number): number {
  return previous > 0 ? current / previous : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function median(values: number[]): number {
  const sorted = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = (sorted.length - 1) / 2;
  const lower = Math.floor(middle);
  const upper = Math.ceil(middle);
  return lower === upper ? sorted[lower] : (sorted[lower] + sorted[upper]) / 2;
}

function findLocalExtrema(values: number[], mode: "PEAK" | "TROUGH"): number[] {
  const points: number[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const previous = values[i - 1];
    const current = values[i];
    const next = values[i + 1];
    if (!(current > 0 && previous > 0 && next > 0)) continue;
    const local = mode === "PEAK"
      ? current >= previous && current >= next
      : current <= previous && current <= next;
    if (!local) continue;
    const reference = mode === "PEAK"
      ? Math.max(previous, next)
      : Math.min(previous, next);
    const prominence = reference > 0
      ? Math.abs(current - reference) / reference
      : 0;
    if (prominence >= 0.05) points.push(i);
  }
  return points;
}

function structureFromExtrema(caps: number[], peaks: number[], troughs: number[]): TrendStructure {
  if (peaks.length < 2 && troughs.length < 2) return "UNKNOWN";
  const latestPeakA = peaks.length >= 2 ? caps[peaks[peaks.length - 2]] : 0;
  const latestPeakB = peaks.length >= 1 ? caps[peaks[peaks.length - 1]] : 0;
  const latestTroughA = troughs.length >= 2 ? caps[troughs[troughs.length - 2]] : 0;
  const latestTroughB = troughs.length >= 1 ? caps[troughs[troughs.length - 1]] : 0;
  const higherHigh = latestPeakA > 0 && latestPeakB >= latestPeakA * 1.05;
  const lowerHigh = latestPeakA > 0 && latestPeakB <= latestPeakA * 0.95;
  const higherLow = latestTroughA > 0 && latestTroughB >= latestTroughA * 1.05;
  const lowerLow = latestTroughA > 0 && latestTroughB <= latestTroughA * 0.95;
  if (higherHigh && higherLow) return "HH_HL";
  if (higherHigh && lowerLow) return "HH_LL";
  if (lowerHigh && higherLow) return "LH_HL";
  if (lowerHigh && lowerLow) return "LH_LL";
  return "FLAT";
}

function lifecyclePhase(
  currentCap: number,
  currentVolume: number,
  peakCap: number,
  peakVolume: number,
  firstExpansionMultiple: number,
  secondExpansionMultiple: number,
  retracementPct: number,
  breakoutQuality: number,
  blowOffRisk: number,
  distributionRisk: number,
  deathRisk: number,
  structure: TrendStructure
): LifecyclePhase {
  if (deathRisk >= 0.72) return "DEATH";
  if (distributionRisk >= 0.62) return "DISTRIBUTION";
  if (peakCap > 0 && currentCap >= peakCap * 0.97 && blowOffRisk >= 0.60) return "PEAK";
  if (secondExpansionMultiple >= 1.20 && (structure === "HH_HL" || structure === "HH_LL")) return "SECONDARY_EXPANSION";
  if (retracementPct >= 8 && retracementPct <= 45 && firstExpansionMultiple >= 1.50) return "RETRACE";
  if (breakoutQuality >= 0.60 && firstExpansionMultiple >= 1.50 && currentVolume >= peakVolume * 0.40) return "EXPANSION";
  if (firstExpansionMultiple >= 1.25) return "BREAKOUT";
  return "BASE";
}

export function analyzeMarketPattern(input: MarketPatternInput): MarketPatternScore {
  const reasons: string[] = [];
  const caps = [
    ...(input.previousMarketCapUsd || []),
    input.marketCapUsd
  ].filter(v => Number.isFinite(v) && v > 0);
  const volumes = [
    ...(input.previousVolumeUsd || []),
    input.volumeUsd
  ].map(v => Number.isFinite(v) && v > 0 ? v : 0);
  const liquidity = [
    ...(input.previousLiquidityUsd || []),
    input.liquidityUsd
  ].map(v => Number.isFinite(v) && v > 0 ? v : 0);

  const previousCap = caps.length >= 2 ? caps[caps.length - 2] : input.marketCapUsd;
  const previousVolume = volumes.length >= 2 ? volumes[volumes.length - 2] : input.volumeUsd;
  const capChange = pctChange(input.marketCapUsd, previousCap);
  const volumeAcceleration = previousVolume > 0 ? input.volumeUsd / previousVolume : 1;
  const totalFlow = Math.max(0, input.buys || 0) + Math.max(0, input.sells || 0);
  const buyRatio = totalFlow > 0 ? Math.max(0, input.buys || 0) / totalFlow : 0.5;

  const localPeaks = findLocalExtrema(caps, "PEAK");
  const localTroughs = findLocalExtrema(caps, "TROUGH");
  const peakIndex = caps.length ? caps.reduce((best, value, index) => value > caps[best] ? index : best, 0) : 0;
  const peakCap = caps[peakIndex] || input.marketCapUsd;
  const peakVolume = volumes[peakIndex] || input.volumeUsd;
  const peakLiquidity = liquidity[peakIndex] || input.liquidityUsd;

  const baseWindowLength = Math.max(3, Math.min(caps.length, Math.floor(caps.length * 0.40)));
  const baseCap = median(caps.slice(0, baseWindowLength)) || caps[0] || input.marketCapUsd;
  const firstExpansionMultiple = safeRatio(peakCap, baseCap);
  const retracementPct = peakCap > 0 ? Math.max(0, ((peakCap - input.marketCapUsd) / peakCap) * 100) : 0;

  const peaksAfterFirst = localPeaks.filter(index => index > peakIndex);
  const secondaryPeak = peaksAfterFirst.length
    ? Math.max(...peaksAfterFirst.map(index => caps[index]))
    : 0;
  const secondExpansionMultiple = peakCap > 0 ? secondaryPeak / peakCap : 0;

  const prePeakVolumes = volumes.slice(0, Math.max(1, peakIndex));
  const baselineVolume = median(prePeakVolumes) || median(volumes) || input.volumeUsd;
  const volumeExpansionRatio = baselineVolume > 0 ? peakVolume / baselineVolume : 1;
  const volumeDecayRatio = peakVolume > 0 ? input.volumeUsd / peakVolume : 1;
  const liquidityChangeSincePeakPct = pctChange(input.liquidityUsd, peakLiquidity);

  const breakoutReturn = caps.length >= 2
    ? Math.max(0, pctChange(caps[Math.min(peakIndex, caps.length - 1)], caps[Math.max(0, peakIndex - Math.max(1, Math.floor(caps.length * 0.2)))]))
    : 0;
  const volumeConfirmation = clamp01((volumeExpansionRatio - 1) / 4);
  const breakoutMagnitude = clamp01(breakoutReturn / 100);
  const liquidityConfirmation = clamp01(1 + liquidityChangeSincePeakPct / 50);
  const breakoutQuality = clamp01(
    breakoutMagnitude * 0.45 +
    volumeConfirmation * 0.35 +
    liquidityConfirmation * 0.20
  );

  const retraceDepth = clamp01(retracementPct / 45);
  const volumeContraction = clamp01(1 - volumeDecayRatio);
  const liquidityRetention = clamp01(1 + liquidityChangeSincePeakPct / 40);
  const retracementQuality = clamp01(
    retraceDepth * 0.25 +
    volumeContraction * 0.35 +
    liquidityRetention * 0.40
  );

  const structure = structureFromExtrema(caps, localPeaks, localTroughs);
  const blowOffRisk = clamp01(
    clamp01((firstExpansionMultiple - 2) / 8) * 0.30 +
    clamp01((volumeExpansionRatio - 1.5) / 5) * 0.25 +
    clamp01(retracementPct / 25) * 0.20 +
    clamp01((capChange < 0 ? Math.abs(capChange) : 0) / 20) * 0.15 +
    clamp01((structure === "LH_HL" || structure === "LH_LL") ? 1 : 0) * 0.10
  );
  const distributionRisk = clamp01(
    clamp01(retracementPct / 35) * 0.28 +
    clamp01((volumeDecayRatio < 1 ? 1 - volumeDecayRatio : 0) / 0.70) * 0.20 +
    clamp01((liquidityChangeSincePeakPct < 0 ? Math.abs(liquidityChangeSincePeakPct) : 0) / 35) * 0.18 +
    clamp01((capChange < 0 ? Math.abs(capChange) : 0) / 20) * 0.16 +
    clamp01((structure === "LH_HL" || structure === "LH_LL") ? 1 : 0) * 0.18
  );
  const deathRisk = clamp01(
    clamp01(retracementPct / 60) * 0.35 +
    clamp01((volumeDecayRatio < 1 ? 1 - volumeDecayRatio : 0) / 0.80) * 0.25 +
    clamp01((liquidityChangeSincePeakPct < 0 ? Math.abs(liquidityChangeSincePeakPct) : 0) / 50) * 0.20 +
    clamp01((capChange < 0 ? Math.abs(capChange) : 0) / 35) * 0.20
  );

  const lifecycle = lifecyclePhase(
    input.marketCapUsd,
    input.volumeUsd,
    peakCap,
    peakVolume,
    firstExpansionMultiple,
    secondExpansionMultiple,
    retracementPct,
    breakoutQuality,
    blowOffRisk,
    distributionRisk,
    deathRisk,
    structure
  );

  let entryScore = 0;
  let exitScore = 0;

  if (volumeAcceleration > 1.5) {
    entryScore += 15;
    reasons.push("volume acceleration");
  }
  if (capChange > 0 && capChange < 15) {
    entryScore += 15;
    reasons.push("healthy upward movement");
  }
  if (buyRatio > 0.6) {
    entryScore += 15;
    reasons.push("buy pressure");
  }
  if (breakoutQuality >= 0.6) {
    entryScore += 20;
    reasons.push("confirmed expansion");
  }
  if (lifecycle === "RETRACE" && retracementQuality >= 0.45) {
    entryScore += 15;
    reasons.push("retracement retains structure");
  }
  if (structure === "HH_HL") {
    entryScore += 15;
    reasons.push("higher highs and higher lows");
  }
  if (blowOffRisk >= 0.55) {
    entryScore -= 20;
    reasons.push("blow-off risk");
  }

  if (capChange < -10) {
    exitScore += 20;
    reasons.push("market cap decline");
  }
  if (buyRatio < 0.4) {
    exitScore += 20;
    reasons.push("sell pressure");
  }
  if (distributionRisk >= 0.55) {
    exitScore += 25;
    reasons.push("distribution structure");
  }
  if (deathRisk >= 0.65) {
    exitScore += 30;
    reasons.push("death-cycle deterioration");
  }
  if (structure === "LH_LL") {
    exitScore += 20;
    reasons.push("lower highs and lower lows");
  }

  let phase: MarketPatternScore["phase"] = "ACCUMULATION";
  if (deathRisk >= 0.65) phase = "DEATH";
  else if (distributionRisk >= 0.55 || exitScore > entryScore && capChange < -5) phase = "DISTRIBUTION";
  else if (entryScore >= 50 && capChange > 0) phase = "EXPANSION";

  if (lifecycle === "BASE") reasons.push("base formation");
  else if (lifecycle === "BREAKOUT") reasons.push("breakout initiation");
  else if (lifecycle === "EXPANSION") reasons.push("expansion phase");
  else if (lifecycle === "PEAK") reasons.push("near peak / exhaustion");
  else if (lifecycle === "RETRACE") reasons.push("post-expansion retrace");
  else if (lifecycle === "SECONDARY_EXPANSION") reasons.push("secondary expansion wave");

  return {
    phase,
    lifecyclePhase: lifecycle,
    trendStructure: structure,
    waveCount: Math.max(0, Math.min(6, localPeaks.length)),
    currentWave: Math.max(1, Math.min(6, localPeaks.length + (secondExpansionMultiple >= 1.2 ? 1 : 0))),
    firstExpansionMultiple,
    retracementPct,
    secondExpansionMultiple,
    volumeExpansionRatio,
    volumeDecayRatio,
    liquidityChangeSincePeakPct,
    breakoutQuality,
    retracementQuality,
    blowOffRisk,
    distributionRisk,
    deathRisk,
    entryScore: Math.max(0, Math.min(100, entryScore)),
    exitScore: Math.max(0, Math.min(100, exitScore)),
    reasons
  };
}
