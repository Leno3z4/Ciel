import { compressForGemini, buildMarketIntelligence } from "./market_intelligence";
import { saveDecision } from "./decision_memory";
import { isCircuitOpen, recordFailure, resetCircuit } from "./circuit_breaker";

export async function prepareGeminiContext(markets: unknown[]) {
  const intelligence = markets
    .map((market) => buildMarketIntelligence(market as any))
    .sort((a, b) => b.entryScore - a.entryScore)
    .slice(0, 3);

  return compressForGemini(intelligence);
}

export async function recordGeminiDecision(env: any, decision: any) {
  await saveDecision(env, {
    token: decision.token,
    decision: decision.action,
    confidence: decision.confidence ?? 0,
    reason: decision.rationale ?? "",
    timestamp: Date.now(),
    result: "pending"
  });
}

export async function checkDecisionHealth(env: any): Promise<boolean> {
  return !(await isCircuitOpen(env));
}

export async function handleDecisionFailure(env: any, reason: string) {
  await recordFailure(env, reason);
}

export async function handleDecisionSuccess(env: any) {
  await resetCircuit(env);
}
