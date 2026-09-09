import { GoogleGenAI, Type } from "@google/genai";

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
  regimeHint: "ACCUMULATION" | "TREND" | "DISTRIBUTION" | "PANIC" | "UNKNOWN";
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

export function buildPatternProfile(rows: Snapshot[]): PatternProfile {
  if (!rows.length) return {
    historySamples: 0, ageHours: 0, hourOfDayUtc: 0, sameHourSamples: 0, currentMarketCapUsd: 0,
    currentMarketCapReturn5mPct: 0, currentMarketCapReturn30mPct: 0, currentMarketCapReturn2hPct: 0,
    marketCapVsMedian: 0, marketCapVsMean: 0, sameHourMarketCapVsBaseline: 0, marketCapPositionPct: 0,
    volumeVsBaseline: 0, liquidityVsBaseline: 0, buyPressure: 0.5, priceVsMedian: 0,
    drawdownFromMarketCapPeakPct: 0, regimeHint: "UNKNOWN"
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
    regimeHint
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
      regimeHint: pattern.regimeHint
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
Decide from a compact feature packet derived from Ciel's full local history. The full raw history is intentionally not sent to you. MARKET CAP is the primary signal: use its multi-horizon movement, position in the token's own range, drawdown, same-hour behavior, and regime. Liquidity and 5m volume are risk/quality confirmation. Buy/sell flow and price are secondary confirmation only. These are already-created established markets; do not chase novelty or new launches. BUY only for a repeatable favorable entry regime with adequate liquidity and sensible risk/reward. HOLD/IGNORE when evidence is weak. SELL for distribution, panic, or deterioration of a held position. Never invent missing data or claim certainty/profitability. Return only the requested JSON.
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
