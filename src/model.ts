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
  meanVolume5m: number;
  meanLiquidity: number;
  volatilityPct: number;
  maxDrawdownPct: number;
  buySellRatio: number;
  priceP10: number;
  priceP90: number;
}

export interface PatternProfile {
  historySamples: number;
  ageHours: number;
  currentReturn5mPct: number;
  currentReturn30mPct: number;
  currentReturn2hPct: number;
  volumeVsBaseline: number;
  liquidityVsBaseline: number;
  buyPressure: number;
  priceVsMedian: number;
  drawdownFromHistoryPeakPct: number;
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

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function pctChange(current: number, previous: number): number {
  return previous > 0 ? ((current - previous) / previous) * 100 : 0;
}

function historyPriceBefore(rows: Snapshot[], msAgo: number): number {
  const newestTs = rows[0]?.tsMs || 0;
  const target = newestTs - msAgo;
  return rows.find(r => r.tsMs <= target && r.priceUsd > 0)?.priceUsd || 0;
}

export function buildPatternProfile(rows: Snapshot[]): PatternProfile {
  if (!rows.length) return {
    historySamples: 0, ageHours: 0, currentReturn5mPct: 0, currentReturn30mPct: 0, currentReturn2hPct: 0,
    volumeVsBaseline: 0, liquidityVsBaseline: 0, buyPressure: 0, priceVsMedian: 0, drawdownFromHistoryPeakPct: 0, regimeHint: "UNKNOWN"
  };
  const current = rows[0];
  const oldest = rows[rows.length - 1];
  const fiveMin = historyPriceBefore(rows, 5 * 60 * 1000);
  const thirtyMin = historyPriceBefore(rows, 30 * 60 * 1000);
  const twoHour = historyPriceBefore(rows, 2 * 60 * 60 * 1000);
  const volumes = rows.map(r => Math.max(0, r.volume5mUsd));
  const liquidity = rows.map(r => Math.max(0, r.liquidityUsd));
  const meanVolume = mean(volumes);
  const meanLiquidity = mean(liquidity);
  const priceSeries = rows.map(r => r.priceUsd).filter(p => Number.isFinite(p) && p > 0);
  const peak = priceSeries.length ? Math.max(...priceSeries) : current.priceUsd;
  const drawdown = peak > 0 ? ((peak - current.priceUsd) / peak) * 100 : 0;
  const flow = Math.max(0, current.buys5m) + Math.max(0, current.sells5m);
  const buyPressure = flow > 0 ? current.buys5m / flow : 0.5;
  const median = percentile(priceSeries, 0.5);
  const currentReturn5mPct = pctChange(current.priceUsd, fiveMin);
  const currentReturn30mPct = pctChange(current.priceUsd, thirtyMin);
  const currentReturn2hPct = pctChange(current.priceUsd, twoHour);
  let regimeHint: PatternProfile["regimeHint"] = "UNKNOWN";
  if (drawdown >= 25 && buyPressure < 0.4) regimeHint = "PANIC";
  else if (drawdown >= 15 && buyPressure < 0.45) regimeHint = "DISTRIBUTION";
  else if (currentReturn30mPct > 8 && buyPressure >= 0.55) regimeHint = "TREND";
  else if (Math.abs(currentReturn30mPct) <= 5 && buyPressure >= 0.55) regimeHint = "ACCUMULATION";
  return {
    historySamples: rows.length,
    ageHours: Math.max(0, (Date.now() - oldest.tsMs) / 3600000),
    currentReturn5mPct,
    currentReturn30mPct,
    currentReturn2hPct,
    volumeVsBaseline: meanVolume > 0 ? current.volume5mUsd / meanVolume : 0,
    liquidityVsBaseline: meanLiquidity > 0 ? current.liquidityUsd / meanLiquidity : 0,
    buyPressure,
    priceVsMedian: median > 0 ? current.priceUsd / median : 0,
    drawdownFromHistoryPeakPct: drawdown,
    regimeHint
  };
}

export function buildBaseline(rows: Snapshot[]): Baseline {
  const prices = rows.map(r => r.priceUsd).filter(Number.isFinite).filter(p => p > 0);
  if (!prices.length) return { samples: 0, meanPrice: 0, medianPrice: 0, meanVolume5m: 0, meanLiquidity: 0, volatilityPct: 0, maxDrawdownPct: 0, buySellRatio: 1, priceP10: 0, priceP90: 0 };

  const returns = prices.slice(1).map((p, i) => prices[i] > 0 ? Math.log(p / prices[i]) * 100 : 0).filter(Number.isFinite);
  const avgReturn = mean(returns);
  const variance = mean(returns.map(x => (x - avgReturn) ** 2));
  let peak = prices[0];
  let maxDrawdownPct = 0;
  for (const price of prices) {
    peak = Math.max(peak, price);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - price) / peak) * 100);
  }
  const buys = rows.reduce((n, r) => n + Math.max(0, r.buys5m), 0);
  const sells = rows.reduce((n, r) => n + Math.max(0, r.sells5m), 0);
  return {
    samples: prices.length,
    meanPrice: mean(prices),
    medianPrice: percentile(prices, 0.5),
    meanVolume5m: mean(rows.map(r => Math.max(0, r.volume5mUsd))),
    meanLiquidity: mean(rows.map(r => Math.max(0, r.liquidityUsd))),
    volatilityPct: Math.sqrt(variance),
    maxDrawdownPct,
    buySellRatio: sells ? buys / sells : buys ? buys : 1,
    priceP10: percentile(prices, 0.10),
    priceP90: percentile(prices, 0.90)
  };
}

export function deviationScore(current: Snapshot, baseline: Baseline): number {
  if (!baseline.samples || current.priceUsd <= 0) return 0;
  const volumeDev = baseline.meanVolume5m > 0 ? Math.abs(current.volume5mUsd - baseline.meanVolume5m) / baseline.meanVolume5m : 0;
  const liquidityDev = baseline.meanLiquidity > 0 ? Math.abs(current.liquidityUsd - baseline.meanLiquidity) / baseline.meanLiquidity : 0;
  const priceDev = baseline.medianPrice > 0 ? Math.abs(Math.log(current.priceUsd / baseline.medianPrice)) : 0;
  const flow = Math.max(0, current.sells5m) + Math.max(0, current.buys5m);
  const imbalance = flow ? Math.abs(current.buys5m - current.sells5m) / flow : 0;
  const drawdown = baseline.maxDrawdownPct > 0 && current.priceUsd < baseline.medianPrice
    ? Math.min(1, ((baseline.medianPrice - current.priceUsd) / baseline.medianPrice) / Math.max(0.01, baseline.maxDrawdownPct / 100))
    : 0;
  return Math.min(1, volumeDev * 0.30 + liquidityDev * 0.15 + Math.min(1, priceDev) * 0.25 + imbalance * 0.20 + drawdown * 0.10);
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

export async function askGemini(apiKey: string | undefined, model: string, role: "market" | "regime", snapshot: Snapshot, baseline: Baseline, score: number, pattern?: PatternProfile): Promise<GeminiDecision | null> {
  if (!apiKey) throw new Error("GEMINI_API_KEY_1 or GEMINI_API_KEY_2 is not configured");
  if (!model?.trim()) throw new Error("GEMINI_MODEL is not configured");
  if (!Number.isFinite(score)) throw new Error("Gemini anomaly score is not finite");

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `${role === "market" ? "You are Ciel's established-meme market analyst." : "You are Ciel's established-meme regime/deviation analyst."}
The token has already passed Ciel's mature/high-volume market filter. Analyze its current behavior against its own historical baseline and its recent multi-horizon pattern profile. Do not claim certainty or profitability. Never invent market data. Do not reward novelty alone. Favor BUY only when the established token shows a favorable risk/reward setup such as sustained buy pressure, constructive momentum, and stable/improving liquidity. Prefer HOLD or IGNORE when evidence is weak. SELL is for distribution, panic, or a deteriorating held position. Return only the requested JSON.
Snapshot: ${JSON.stringify(snapshot)}
Baseline: ${JSON.stringify(baseline)}
Pattern profile: ${JSON.stringify(pattern || buildPatternProfile([snapshot]))}
Deterministic anomaly score: ${score.toFixed(4)}`;

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
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 500)}`);
    }
    if (!validDecision(parsed)) throw new Error(`Gemini returned an invalid decision: ${raw.slice(0, 800)}`);
    return parsed;
  } catch (error) {
    const message = String(error).replace(/^Error:\s*/, "").slice(0, 1000);
    throw new Error(message || "Gemini request failed");
  }
}
