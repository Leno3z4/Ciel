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
  meanVolume5m: number;
  meanLiquidity: number;
  volatilityPct: number;
  maxDrawdownPct: number;
  buySellRatio: number;
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

export function buildBaseline(rows: Snapshot[]): Baseline {
  if (!rows.length) return { samples: 0, meanPrice: 0, meanVolume5m: 0, meanLiquidity: 0, volatilityPct: 0, maxDrawdownPct: 0, buySellRatio: 1 };
  const prices = rows.map(r => r.priceUsd).filter(Number.isFinite);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const meanPrice = mean(prices);
  const meanVolume5m = mean(rows.map(r => r.volume5mUsd));
  const meanLiquidity = mean(rows.map(r => r.liquidityUsd));
  const returns = prices.slice(1).map((p, i) => prices[i] ? ((p / prices[i]) - 1) * 100 : 0);
  const avg = mean(returns);
  const variance = mean(returns.map(x => (x - avg) ** 2));
  let peak = prices[0] || 0;
  let maxDrawdownPct = 0;
  for (const p of prices) { peak = Math.max(peak, p); if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - p) / peak) * 100); }
  const buys = rows.reduce((n, r) => n + r.buys5m, 0);
  const sells = rows.reduce((n, r) => n + r.sells5m, 0);
  return { samples: rows.length, meanPrice, meanVolume5m, meanLiquidity, volatilityPct: Math.sqrt(variance), maxDrawdownPct, buySellRatio: sells ? buys / sells : buys ? buys : 1 };
}

export function deviationScore(current: Snapshot, baseline: Baseline): number {
  if (!baseline.samples) return 0;
  const volumeDev = baseline.meanVolume5m > 0 ? Math.abs(current.volume5mUsd - baseline.meanVolume5m) / baseline.meanVolume5m : 0;
  const liquidityDev = baseline.meanLiquidity > 0 ? Math.abs(current.liquidityUsd - baseline.meanLiquidity) / baseline.meanLiquidity : 0;
  const flow = current.sells5m + current.buys5m;
  const imbalance = flow ? Math.abs(current.buys5m - current.sells5m) / flow : 0;
  return Math.min(1, volumeDev * 0.5 + liquidityDev * 0.2 + imbalance * 0.3);
}

export async function askGemini(apiKey: string | undefined, model: string, role: "market" | "regime", snapshot: Snapshot, baseline: Baseline, score: number): Promise<GeminiDecision | null> {
  if (!apiKey) return null;
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `${role === "market" ? "You are Ciel's market analyst." : "You are Ciel's regime/deviation analyst."}\nAnalyze this token snapshot against its historical baseline. Do not assume profitability. Prefer HOLD/IGNORE when evidence is weak. Return a decision only from the schema.\nSnapshot: ${JSON.stringify(snapshot)}\nBaseline: ${JSON.stringify(baseline)}\nDeterministic anomaly score: ${score.toFixed(4)}`;
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ["BUY", "HOLD", "SELL", "IGNORE"] },
          confidence: { type: Type.NUMBER },
          anomalyScore: { type: Type.NUMBER },
          expectedLowUsd: { type: Type.NUMBER },
          expectedHighUsd: { type: Type.NUMBER },
          regime: { type: Type.STRING, enum: ["ACCUMULATION", "TREND", "DISTRIBUTION", "PANIC", "UNKNOWN"] },
          rationale: { type: Type.STRING }
        },
        required: ["action", "confidence", "anomalyScore", "expectedLowUsd", "expectedHighUsd", "regime", "rationale"]
      }
    }
  });
  try { return JSON.parse(response.text || "null") as GeminiDecision; } catch { return null; }
}
