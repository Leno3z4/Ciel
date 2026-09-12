import { GoogleGenAI, Type } from "@google/genai";
import { analyzeMarketPattern } from "./pattern_engine";

export interface Snapshot {
  token: string;
  tsMs: number;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buys5m: number;
  sells5m: number;
  holders: number;
}

export interface Baseline {
  samples: number;
  meanPrice: number;
  medianPrice: number;
  meanMarketCap: number;
  medianMarketCap: number;
  meanVolume5m: number;
  meanLiquidity: number;
  marketCapVolatilityPct: number;
  maxMarketCapDrawdownPct: number;
  buySellRatio: number;
  marketCapP10: number;
  marketCapP90: number;
}

export interface PriceBehaviorProfile {
  observations24h: number;
  observations12h: number;
  avgLowPrice12h: number;
  avgHighPrice12h: number;
  avgLowPrice24h: number;
  avgHighPrice24h: number;
  lowestPrice24h: number;
  highestPrice24h: number;
  currentVsAvgLow24hPct: number;
  currentVsAvgHigh24hPct: number;
  currentRangePositionPct: number;
  avgMinutesNearLow12h: number;
  avgMinutesNearHigh12h: number;
  avgMinutesNearLow24h: number;
  avgMinutesNearHigh24h: number;
  currentMinutesInZone: number;
  currentZone: "LOW" | "MIDDLE" | "HIGH" | "UNKNOWN";
}

export interface PatternProfile {
  historySamples: number;
  ageHours: number;
  hourOfDayUtc: number;
  sameHourSamples: number;
  currentMarketCapUsd: number;
  currentMarketCapReturn5mPct: number;
  currentMarketCapReturn30mPct: number;
  currentMarketCapReturn2hPct: number;
  marketCapVsMedian: number;
  marketCapVsMean: number;
  sameHourMarketCapVsBaseline: number;
  marketCapPositionPct: number;
  volumeVsBaseline: number;
  liquidityVsBaseline: number;
  buyPressure: number;
  priceVsMedian: number;
  drawdownFromMarketCapPeakPct: number;
  priceBehavior: PriceBehaviorProfile;
  regimeHint: "ACCUMULATION" | "TREND" | "DISTRIBUTION" | "PANIC" | "UNKNOWN";
  lifecyclePhase: string;
  trendStructure: string;
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
}

export interface GeminiDecision {
  action: "BUY" | "HOLD" | "SELL" | "IGNORE";
  confidence: number;
  anomalyScore: number;
  expectedLowUsd: number;
  expectedHighUsd: number;
  regime: "ACCUMULATION" | "TREND" | "DISTRIBUTION" | "PANIC" | "UNKNOWN";
  rationale: string;
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index); const hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}
function pctChange(current: number, previous: number): number { return previous > 0 ? ((current - previous) / previous) * 100 : 0; }

function historyValueBefore(rows: Snapshot[], msAgo: number, key: keyof Pick<Snapshot, "priceUsd" | "marketCapUsd">): number {
  const newestTs = rows[0]?.tsMs || 0;
  const target = newestTs - msAgo;
  return rows.find(r => r.tsMs <= target && Number(r[key]) > 0)?.[key] || 0;
}

function meanFinite(values: number[]): number { return mean(values.filter(v => Number.isFinite(v) && v > 0)); }

function emptyPriceBehavior(): PriceBehaviorProfile {
  return {
    observations24h: 0,
    observations12h: 0,
    avgLowPrice12h: 0,
    avgHighPrice12h: 0,
    avgLowPrice24h: 0,
    avgHighPrice24h: 0,
    lowestPrice24h: 0,
    highestPrice24h: 0,
    currentVsAvgLow24hPct: 0,
    currentVsAvgHigh24hPct: 0,
    currentRangePositionPct: 0,
    avgMinutesNearLow12h: 0,
    avgMinutesNearHigh12h: 0,
    avgMinutesNearLow24h: 0,
    avgMinutesNearHigh24h: 0,
    currentMinutesInZone: 0,
    currentZone: "UNKNOWN"
  };
}

function buildPriceBehavior(rows: Snapshot[]): PriceBehaviorProfile {
  if (!rows.length) return emptyPriceBehavior();

  const newestTs = Math.max(...rows.map(row => row.tsMs));
  const cutoff24h = newestTs - 24 * 60 * 60 * 1000;
  const cutoff12h = newestTs - 12 * 60 * 60 * 1000;
  const valid = rows
    .filter(row => row.tsMs >= cutoff24h && Number.isFinite(row.priceUsd) && row.priceUsd > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  if (!valid.length) return emptyPriceBehavior();

  const last12h = valid.filter(row => row.tsMs >= cutoff12h);
  const prices24h = valid.map(row => row.priceUsd);
  const prices12h = last12h.length ? last12h.map(row => row.priceUsd) : prices24h;
  const low24h = Math.min(...prices24h);
  const high24h = Math.max(...prices24h);
  const low12h = Math.min(...prices12h);
  const high12h = Math.max(...prices12h);
  const range24h = high24h - low24h;
  const range12h = high12h - low12h;
  const nearLow24h = low24h + range24h * 0.20;
  const nearHigh24h = high24h - range24h * 0.20;
  const nearLow12h = low12h + range12h * 0.20;
  const nearHigh12h = high12h - range12h * 0.20;

  function durationNear(windowRows: Snapshot[], lowThreshold: number, highThreshold: number): { lowMinutes: number; highMinutes: number } {
    let lowMs = 0;
    let highMs = 0;
    for (let i = 1; i < windowRows.length; i++) {
      const previous = windowRows[i - 1];
      const current = windowRows[i];
      const gapMs = current.tsMs - previous.tsMs;
      if (gapMs <= 0 || gapMs > 10 * 60 * 1000) continue;
      if (previous.priceUsd <= lowThreshold) lowMs += gapMs;
      if (previous.priceUsd >= highThreshold) highMs += gapMs;
    }
    return { lowMinutes: lowMs / 60000, highMinutes: highMs / 60000 };
  }

  function blockStats(windowRows: Snapshot[]): { low: number; high: number; lowMinutes: number; highMinutes: number } {
    if (!windowRows.length) return { low: 0, high: 0, lowMinutes: 0, highMinutes: 0 };
    const prices = windowRows.map(row => row.priceUsd).filter(price => Number.isFinite(price) && price > 0);
    if (!prices.length) return { low: 0, high: 0, lowMinutes: 0, highMinutes: 0 };
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const range = high - low;
    const timing = durationNear(windowRows, low + range * 0.20, high - range * 0.20);
    return { low, high, lowMinutes: timing.lowMinutes, highMinutes: timing.highMinutes };
  }

  const twelveHourBlocks: Snapshot[][] = [];
  const firstBlockEnd = cutoff12h;
  const olderBlock = valid.filter(row => row.tsMs < firstBlockEnd);
  if (olderBlock.length) twelveHourBlocks.push(olderBlock);
  if (last12h.length) twelveHourBlocks.push(last12h);
  if (!twelveHourBlocks.length) twelveHourBlocks.push(valid);

  const blocks = twelveHourBlocks.map(blockStats);
  const avgLow24h = mean(blocks.map(block => block.low).filter(price => price > 0));
  const avgHigh24h = mean(blocks.map(block => block.high).filter(price => price > 0));
  const avgLowMinutes24h = mean(blocks.map(block => block.lowMinutes));
  const avgHighMinutes24h = mean(blocks.map(block => block.highMinutes));
  const twelveHourTiming = durationNear(last12h.length ? last12h : valid, nearLow12h, nearHigh12h);

  const current = valid[valid.length - 1].priceUsd;
  const currentRangePositionPct = range24h > 0 ? Math.max(0, Math.min(100, ((current - low24h) / range24h) * 100)) : 50;
  const currentIsLow = current <= nearLow24h;
  const currentIsHigh = current >= nearHigh24h;
  let currentZone: PriceBehaviorProfile["currentZone"] = "MIDDLE";
  if (currentIsLow) currentZone = "LOW";
  else if (currentIsHigh) currentZone = "HIGH";

  let currentZoneStart = valid[valid.length - 1].tsMs;
  if (currentZone !== "MIDDLE") {
    for (let i = valid.length - 2; i >= 0; i--) {
      const previous = valid[i];
      const next = valid[i + 1];
      const gapMs = next.tsMs - previous.tsMs;
      if (gapMs <= 0 || gapMs > 10 * 60 * 1000) break;
      const sameZone = (currentZone === "LOW" && previous.priceUsd <= nearLow24h) ||
        (currentZone === "HIGH" && previous.priceUsd >= nearHigh24h);
      if (!sameZone) break;
      currentZoneStart = previous.tsMs;
    }
  }

  const currentMinutesInZone = currentZone === "MIDDLE" ? 0 : Math.max(0, (newestTs - currentZoneStart) / 60000);
  return {
    observations24h: valid.length,
    observations12h: last12h.length,
    avgLowPrice12h: low12h,
    avgHighPrice12h: high12h,
    avgLowPrice24h: avgLow24h || low24h,
    avgHighPrice24h: avgHigh24h || high24h,
    lowestPrice24h: low24h,
    highestPrice24h: high24h,
    currentVsAvgLow24hPct: avgLow24h > 0 ? pctChange(current, avgLow24h) : 0,
    currentVsAvgHigh24hPct: avgHigh24h > 0 ? pctChange(current, avgHigh24h) : 0,
    currentRangePositionPct,
    avgMinutesNearLow12h: twelveHourTiming.lowMinutes,
    avgMinutesNearHigh12h: twelveHourTiming.highMinutes,
    avgMinutesNearLow24h: avgLowMinutes24h,
    avgMinutesNearHigh24h: avgHighMinutes24h,
    currentMinutesInZone,
    currentZone
  };
}

export function buildPatternProfile(rows: Snapshot[]): PatternProfile {
  if (!rows.length) return {
    historySamples: 0, ageHours: 0, hourOfDayUtc: 0, sameHourSamples: 0, currentMarketCapUsd: 0,
    currentMarketCapReturn5mPct: 0, currentMarketCapReturn30mPct: 0, currentMarketCapReturn2hPct: 0,
    marketCapVsMedian: 0, marketCapVsMean: 0, sameHourMarketCapVsBaseline: 0, marketCapPositionPct: 0,
    volumeVsBaseline: 0, liquidityVsBaseline: 0, buyPressure: 0.5, priceVsMedian: 0,
    drawdownFromMarketCapPeakPct: 0, priceBehavior: emptyPriceBehavior(), regimeHint: "UNKNOWN",
    lifecyclePhase: "BASE", trendStructure: "UNKNOWN", waveCount: 0, currentWave: 0,
    firstExpansionMultiple: 0, retracementPct: 0, secondExpansionMultiple: 0,
    volumeExpansionRatio: 0, volumeDecayRatio: 0, liquidityChangeSincePeakPct: 0,
    breakoutQuality: 0, retracementQuality: 0, blowOffRisk: 0, distributionRisk: 0, deathRisk: 0
  };
  const current = rows[0];
  const oldest = rows[rows.length - 1];
  const caps = rows.map(r => Number(r.marketCapUsd)).filter(v => Number.isFinite(v) && v > 0);
  const prices = rows.map(r => Number(r.priceUsd)).filter(v => Number.isFinite(v) && v > 0);
  const capMean = mean(caps); const capMedian = percentile(caps, 0.5);
  const capPeak = caps.length ? Math.max(...caps) : current.marketCapUsd;
  const drawdown = capPeak > 0 ? ((capPeak - current.marketCapUsd) / capPeak) * 100 : 0;
  const fiveMin = historyValueBefore(rows, 5 * 60 * 1000, "marketCapUsd");
  const thirtyMin = historyValueBefore(rows, 30 * 60 * 1000, "marketCapUsd");
  const twoHour = historyValueBefore(rows, 2 * 60 * 60 * 1000, "marketCapUsd");
  const volumes = rows.map(r => Math.max(0, r.volume5mUsd));
  const liquidity = rows.map(r => Math.max(0, r.liquidityUsd));
  const meanVolume = meanFinite(volumes); const meanLiquidity = meanFinite(liquidity);
  const currentHour = new Date(current.tsMs).getUTCHours();
  const sameHour = rows.filter(r => new Date(r.tsMs).getUTCHours() === currentHour && r.marketCapUsd > 0).map(r => r.marketCapUsd);
  const sameHourMean = mean(sameHour);
  const range = caps.length ? Math.max(...caps) - Math.min(...caps) : 0;
  const marketCapPositionPct = range > 0 ? ((current.marketCapUsd - Math.min(...caps)) / range) * 100 : 50;
  const flow = Math.max(0, current.buys5m) + Math.max(0, current.sells5m);
  const buyPressure = flow > 0 ? Math.max(0, current.buys5m) / flow : 0.5;
  const priceMedian = percentile(prices, 0.5);
  const capReturn30 = pctChange(current.marketCapUsd, thirtyMin);
  let regimeHint: PatternProfile["regimeHint"] = "UNKNOWN";
  if (drawdown >= 25 && buyPressure < 0.4) regimeHint = "PANIC";
  else if (drawdown >= 15 && capReturn30 < -5) regimeHint = "DISTRIBUTION";
  else if (capReturn30 > 8 && buyPressure >= 0.45) regimeHint = "TREND";
  else if (Math.abs(capReturn30) <= 5 && buyPressure >= 0.45) regimeHint = "ACCUMULATION";

  const lifecycle = analyzeMarketPattern({
    marketCapUsd: current.marketCapUsd,
    previousMarketCapUsd: [...rows.slice(1)].reverse().map(row => row.marketCapUsd),
    volumeUsd: current.volume5mUsd,
    previousVolumeUsd: [...rows.slice(1)].reverse().map(row => row.volume5mUsd),
    liquidityUsd: current.liquidityUsd,
    previousLiquidityUsd: [...rows.slice(1)].reverse().map(row => row.liquidityUsd),
    buys: current.buys5m,
    sells: current.sells5m,
    hourUtc: currentHour
  });

  return {
    historySamples: rows.length,
    ageHours: Math.max(0, (Date.now() - oldest.tsMs) / 3600000),
    hourOfDayUtc: currentHour,
    sameHourSamples: sameHour.length,
    currentMarketCapUsd: current.marketCapUsd,
    currentMarketCapReturn5mPct: pctChange(current.marketCapUsd, fiveMin),
    currentMarketCapReturn30mPct: capReturn30,
    currentMarketCapReturn2hPct: pctChange(current.marketCapUsd, twoHour),
    marketCapVsMedian: capMedian > 0 ? current.marketCapUsd / capMedian : 0,
    marketCapVsMean: capMean > 0 ? current.marketCapUsd / capMean : 0,
    sameHourMarketCapVsBaseline: sameHourMean > 0 ? current.marketCapUsd / sameHourMean : 0,
    marketCapPositionPct,
    volumeVsBaseline: meanVolume > 0 ? current.volume5mUsd / meanVolume : 0,
    liquidityVsBaseline: meanLiquidity > 0 ? current.liquidityUsd / meanLiquidity : 0,
    buyPressure,
    priceVsMedian: priceMedian > 0 ? current.priceUsd / priceMedian : 0,
    drawdownFromMarketCapPeakPct: drawdown,
    priceBehavior: buildPriceBehavior(rows),
    regimeHint,
    lifecyclePhase: lifecycle.lifecyclePhase,
    trendStructure: lifecycle.trendStructure,
    waveCount: lifecycle.waveCount,
    currentWave: lifecycle.currentWave,
    firstExpansionMultiple: lifecycle.firstExpansionMultiple,
    retracementPct: lifecycle.retracementPct,
    secondExpansionMultiple: lifecycle.secondExpansionMultiple,
    volumeExpansionRatio: lifecycle.volumeExpansionRatio,
    volumeDecayRatio: lifecycle.volumeDecayRatio,
    liquidityChangeSincePeakPct: lifecycle.liquidityChangeSincePeakPct,
    breakoutQuality: lifecycle.breakoutQuality,
    retracementQuality: lifecycle.retracementQuality,
    blowOffRisk: lifecycle.blowOffRisk,
    distributionRisk: lifecycle.distributionRisk,
    deathRisk: lifecycle.deathRisk
  };
}

export function buildBaseline(rows: Snapshot[]): Baseline {
  const prices = rows.map(r => r.priceUsd).filter(Number.isFinite).filter(p => p > 0);
  const caps = rows.map(r => r.marketCapUsd).filter(Number.isFinite).filter(c => c > 0);
  if (!prices.length || !caps.length) return { samples: 0, meanPrice: 0, medianPrice: 0, meanMarketCap: 0, medianMarketCap: 0, meanVolume5m: 0, meanLiquidity: 0, marketCapVolatilityPct: 0, maxMarketCapDrawdownPct: 0, buySellRatio: 1, marketCapP10: 0, marketCapP90: 0 };
  const capReturns = caps.slice(1).map((cap, i) => caps[i] > 0 ? Math.log(cap / caps[i]) * 100 : 0).filter(Number.isFinite);
  const avgReturn = mean(capReturns);
  const variance = mean(capReturns.map(x => (x - avgReturn) ** 2));
  let peak = caps[0]; let maxMarketCapDrawdownPct = 0;
  for (const cap of caps) { peak = Math.max(peak, cap); if (peak > 0) maxMarketCapDrawdownPct = Math.max(maxMarketCapDrawdownPct, ((peak - cap) / peak) * 100); }
  const buys = rows.reduce((n, r) => n + Math.max(0, r.buys5m), 0);
  const sells = rows.reduce((n, r) => n + Math.max(0, r.sells5m), 0);
  return {
    samples: caps.length,
    meanPrice: mean(prices), medianPrice: percentile(prices, 0.5),
    meanMarketCap: mean(caps), medianMarketCap: percentile(caps, 0.5),
    meanVolume5m: mean(rows.map(r => Math.max(0, r.volume5mUsd))),
    meanLiquidity: mean(rows.map(r => Math.max(0, r.liquidityUsd))),
    marketCapVolatilityPct: Math.sqrt(variance),
    maxMarketCapDrawdownPct,
    buySellRatio: sells ? buys / sells : buys ? buys : 1,
    marketCapP10: percentile(caps, 0.10), marketCapP90: percentile(caps, 0.90)
  };
}

export function deviationScore(current: Snapshot, baseline: Baseline): number {
  if (!baseline.samples || current.marketCapUsd <= 0) return 0;
  const marketCapDev = baseline.medianMarketCap > 0 ? Math.abs(Math.log(current.marketCapUsd / baseline.medianMarketCap)) : 0;
  const marketCapRangeDev = baseline.marketCapP90 > baseline.marketCapP10 ? Math.min(1, Math.abs(current.marketCapUsd - baseline.medianMarketCap) / (baseline.marketCapP90 - baseline.marketCapP10)) : 0;
  const liquidityDev = baseline.meanLiquidity > 0 ? Math.min(1, Math.abs(current.liquidityUsd - baseline.meanLiquidity) / baseline.meanLiquidity) : 0;
  const volumeDev = baseline.meanVolume5m > 0 ? Math.min(1, Math.abs(current.volume5mUsd - baseline.meanVolume5m) / baseline.meanVolume5m) : 0;
  const priceDev = baseline.medianPrice > 0 ? Math.min(1, Math.abs(Math.log(current.priceUsd / baseline.medianPrice))) : 0;
  const flow = Math.max(0, current.sells5m) + Math.max(0, current.buys5m);
  const imbalance = flow ? Math.abs(current.buys5m - current.sells5m) / flow : 0;
  return Math.min(1, marketCapDev * 0.30 + marketCapRangeDev * 0.25 + liquidityDev * 0.15 + volumeDev * 0.10 + priceDev * 0.10 + imbalance * 0.10);
}

function validDecision(value: unknown): value is GeminiDecision {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return ["BUY", "HOLD", "SELL", "IGNORE"].includes(String(x.action)) &&
    Number.isFinite(Number(x.confidence)) && Number(x.confidence) >= 0 && Number(x.confidence) <= 1 &&
    Number.isFinite(Number(x.anomalyScore)) && Number(x.anomalyScore) >= 0 && Number(x.anomalyScore) <= 1 &&
    Number.isFinite(Number(x.expectedLowUsd)) && Number(x.expectedLowUsd) >= 0 &&
    Number.isFinite(Number(x.expectedHighUsd)) && Number(x.expectedHighUsd) >= 0 &&
    ["ACCUMULATION", "TREND", "DISTRIBUTION", "PANIC", "UNKNOWN"].includes(String(x.regime)) &&
    typeof x.rationale === "string";
}

function compactDecisionPacket(snapshot: Snapshot, baseline: Baseline, pattern: PatternProfile, score: number): Record<string, unknown> {
  return {
    current: {
      marketCapUsd: Math.round(snapshot.marketCapUsd),
      capReturn5mPct: Number(pattern.currentMarketCapReturn5mPct.toFixed(2)),
      capReturn30mPct: Number(pattern.currentMarketCapReturn30mPct.toFixed(2)),
      capReturn2hPct: Number(pattern.currentMarketCapReturn2hPct.toFixed(2)),
      capVsMedian: Number(pattern.marketCapVsMedian.toFixed(3)),
      capVsMean: Number(pattern.marketCapVsMean.toFixed(3)),
      capVsSameHour: Number(pattern.sameHourMarketCapVsBaseline.toFixed(3)),
      capPositionPct: Number(pattern.marketCapPositionPct.toFixed(1)),
      drawdownPct: Number(pattern.drawdownFromMarketCapPeakPct.toFixed(2)),
      regimeHint: pattern.regimeHint,
      lifecyclePhase: pattern.lifecyclePhase,
      trendStructure: pattern.trendStructure
    },
    liquidity: {
      usd: Math.round(snapshot.liquidityUsd),
      vsBaseline: Number(pattern.liquidityVsBaseline.toFixed(3)),
      volume5mUsd: Math.round(snapshot.volume5mUsd),
      volumeVsBaseline: Number(pattern.volumeVsBaseline.toFixed(3))
    },
    confirmation: {
      buyPressure: Number(pattern.buyPressure.toFixed(3)),
      priceVsMedian: Number(pattern.priceVsMedian.toFixed(3)),
      sameHourSamples: pattern.sameHourSamples
    },
    lifecycle: {
      phase: pattern.lifecyclePhase,
      structure: pattern.trendStructure,
      waveCount: pattern.waveCount,
      currentWave: pattern.currentWave,
      firstExpansionMultiple: Number(pattern.firstExpansionMultiple.toFixed(3)),
      retracementPct: Number(pattern.retracementPct.toFixed(2)),
      secondExpansionMultiple: Number(pattern.secondExpansionMultiple.toFixed(3)),
      breakoutQuality: Number(pattern.breakoutQuality.toFixed(3)),
      retracementQuality: Number(pattern.retracementQuality.toFixed(3)),
      volumeExpansionRatio: Number(pattern.volumeExpansionRatio.toFixed(3)),
      volumeDecayRatio: Number(pattern.volumeDecayRatio.toFixed(3)),
      liquidityChangeSincePeakPct: Number(pattern.liquidityChangeSincePeakPct.toFixed(2)),
      blowOffRisk: Number(pattern.blowOffRisk.toFixed(3)),
      distributionRisk: Number(pattern.distributionRisk.toFixed(3)),
      deathRisk: Number(pattern.deathRisk.toFixed(3))
    },
    priceBehavior: {
      observations12h: pattern.priceBehavior.observations12h,
      observations24h: pattern.priceBehavior.observations24h,
      avgLowPrice12h: pattern.priceBehavior.avgLowPrice12h,
      avgHighPrice12h: pattern.priceBehavior.avgHighPrice12h,
      avgLowPrice24h: pattern.priceBehavior.avgLowPrice24h,
      avgHighPrice24h: pattern.priceBehavior.avgHighPrice24h,
      lowestPrice24h: pattern.priceBehavior.lowestPrice24h,
      highestPrice24h: pattern.priceBehavior.highestPrice24h,
      currentVsAvgLow24hPct: Number(pattern.priceBehavior.currentVsAvgLow24hPct.toFixed(2)),
      currentVsAvgHigh24hPct: Number(pattern.priceBehavior.currentVsAvgHigh24hPct.toFixed(2)),
      currentRangePositionPct: Number(pattern.priceBehavior.currentRangePositionPct.toFixed(1)),
      avgMinutesNearLow12h: Number(pattern.priceBehavior.avgMinutesNearLow12h.toFixed(1)),
      avgMinutesNearHigh12h: Number(pattern.priceBehavior.avgMinutesNearHigh12h.toFixed(1)),
      avgMinutesNearLow24h: Number(pattern.priceBehavior.avgMinutesNearLow24h.toFixed(1)),
      avgMinutesNearHigh24h: Number(pattern.priceBehavior.avgMinutesNearHigh24h.toFixed(1)),
      currentMinutesInZone: Number(pattern.priceBehavior.currentMinutesInZone.toFixed(1)),
      currentZone: pattern.priceBehavior.currentZone
    },
    baseline: {
      samples: baseline.samples,
      medianMarketCapUsd: Math.round(baseline.medianMarketCap),
      p10MarketCapUsd: Math.round(baseline.marketCapP10),
      p90MarketCapUsd: Math.round(baseline.marketCapP90),
      volatilityPct: Number(baseline.marketCapVolatilityPct.toFixed(2)),
      maxDrawdownPct: Number(baseline.maxMarketCapDrawdownPct.toFixed(2))
    },
    history: {
      samples: pattern.historySamples,
      ageHours: Number(pattern.ageHours.toFixed(2)),
      hourUtc: pattern.hourOfDayUtc
    },
    deterministicAnomalyScore: Number(score.toFixed(4))
  };
}

export async function askGemini(apiKey: string | undefined, model: string, role: "market" | "regime", snapshot: Snapshot, baseline: Baseline, score: number, pattern?: PatternProfile): Promise<GeminiDecision | null> {
  if (!apiKey) throw new Error("Gemini API key is not configured");
  if (!model?.trim()) throw new Error("GEMINI_MODEL is not configured");
  if (!Number.isFinite(score)) throw new Error("Gemini anomaly score is not finite");
  const effectivePattern = pattern || buildPatternProfile([snapshot]);
  const packet = compactDecisionPacket(snapshot, baseline, effectivePattern, score);
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `${role === "market" ? "You are Ciel's established-meme market decision engine." : "You are Ciel's established-meme regime/deviation decision engine."}
Decide from a compact feature packet derived from Ciel's full local history. The full raw history is intentionally not sent to you. MARKET CAP is the primary signal: use its multi-horizon movement, position in the token's own range, drawdown, same-hour behavior, regime, lifecycle phase, wave/market structure, breakout quality, retracement quality, volume exhaustion, liquidity change, and the token-specific price-behavior timing profile. The price-behavior profile contains 12h and 24h low/high levels, rolling average lows/highs, the token's current position in its own historical range, typical time spent near low/high zones, and current time spent in its current low/high zone. Use this as a timing confirmation layer, not a guarantee that history repeats. Prefer BUY only when the broader market evidence supports an entry and the price is attractively positioned relative to the token's own historical low/accumulation behavior. Prefer SELL for a held position when price is near the token's historical high zone and distribution, weakening momentum, or other deterioration confirms the exit. Do not chase a price merely because it is below an average, and do not assume a high will be revisited. Liquidity and 5m volume remain risk/quality confirmation. These are already-created established markets; do not chase novelty or new launches. Never invent missing data or claim certainty/profitability. Return only the requested JSON.
Decision packet: ${JSON.stringify(packet)}`;
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            action: { type: Type.STRING, enum: ["BUY", "HOLD", "SELL", "IGNORE"] },
            confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
            anomalyScore: { type: Type.NUMBER, minimum: 0, maximum: 1 },
            expectedLowUsd: { type: Type.NUMBER, minimum: 0 },
            expectedHighUsd: { type: Type.NUMBER, minimum: 0 },
            regime: { type: Type.STRING, enum: ["ACCUMULATION", "TREND", "DISTRIBUTION", "PANIC", "UNKNOWN"] },
            rationale: { type: Type.STRING }
          },
          required: ["action", "confidence", "anomalyScore", "expectedLowUsd", "expectedHighUsd", "regime", "rationale"]
        }
      }
    });
    const raw = response.text || "";
    if (!raw.trim()) throw new Error("Gemini returned an empty response");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 500)}`); }
    if (!validDecision(parsed)) throw new Error(`Gemini returned an invalid decision: ${raw.slice(0, 800)}`);
    return parsed;
  } catch (error) {
    const message = String(error).replace(/^Error:\s*/, "").slice(0, 1000);
    throw new Error(message || "Gemini request failed");
  }
}
