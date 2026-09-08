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
    Number.isFinite(Number(x.anomalyScore)) &&
    Number.isFinite(Number(x.expectedLowUsd)) && Number(x.expectedLowUsd) >= 0 &&
    Number.isFinite(Number(x.expectedHighUsd)) && Number(x.expectedHighUsd) >= 0 &&
    ["ACCUMULATION", "TREND", "DISTRIBUTION", "PANIC", "UNKNOWN"].includes(String(x.regime)) &&
    typeof x.rationale === "string";
}

export async function askGemini(apiKey: string | undefined, model: string, role: "market" | "regime", snapshot: Snapshot, baseline: Baseline, score: number): Promise<GeminiDecision | null> {
  if (!apiKey) return null;
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `${role === "market" ? "You are Ciel's market analyst." : "You are Ciel's regime/deviation analyst."}\nAnalyze the supplied token data against its token-specific historical baseline. Do not claim certainty or profitability. Never invent market data. BUY only when evidence supports a favorable risk/reward versus the observed baseline; otherwise prefer HOLD or IGNORE. SELL is for evidence of distribution, panic, or a deteriorating held position. Return only the requested JSON.\nSnapshot: ${JSON.stringify(snapshot)}\nBaseline: ${JSON.stringify(baseline)}\nDeterministic anomaly score: ${score.toFixed(4)}`;
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
    const parsed: unknown = JSON.parse(response.text || "null");
    return validDecision(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
