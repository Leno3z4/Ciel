import { prepareGeminiContext, recordGeminiDecision, checkDecisionHealth, handleDecisionFailure, handleDecisionSuccess } from "./intelligence_pipeline";
import { riskGate } from "./risk";

export type CielDecision = {
  token: string;
  action: "BUY" | "SELL" | "WAIT";
  confidence?: number;
  rationale?: string;
  liquidityUsd?: number;
  slippageBps?: number;
  portfolioExposurePct?: number;
  positionPct?: number;
  priceChangePct?: number;
  expectedLowUsd?: number;
  expectedHighUsd?: number;
  anomalyScore?: number;
  regime?: "ACCUMULATION" | "TREND" | "DISTRIBUTION" | "PANIC" | "UNKNOWN";
};

/**
 * Shared orchestration wrapper for decision cycles.
 * Keeps intelligence preparation, circuit protection, risk protection and
 * decision memory outside the executor.
 */
export async function runDecisionPipeline(
  env: any,
  markets: unknown[],
  decide: (context: unknown) => Promise<CielDecision>
): Promise<CielDecision> {
  if (!(await checkDecisionHealth(env))) {
    return { token: "", action: "WAIT", confidence: 0, rationale: "paper circuit breaker open" };
  }

  try {
    const context = await prepareGeminiContext(markets);
    const decision = await decide(context);

    if (decision.action === "BUY") {
      const gate = riskGate({
        confidence: decision.confidence ?? 0,
        liquidityUsd: decision.liquidityUsd ?? 0,
        slippageBps: decision.slippageBps ?? 0,
        portfolioExposurePct: decision.portfolioExposurePct ?? 0,
        positionPct: decision.positionPct ?? 0,
        priceChangePct: decision.priceChangePct ?? 0
      });

      if (!gate.allowed) {
        const blocked = {
          ...decision,
          action: "WAIT" as const,
          rationale: `${decision.rationale ?? ""} | risk blocked: ${gate.reasons.join(", ")}`
        };
        await recordGeminiDecision(env, blocked);
        return blocked;
      }
    }

    await recordGeminiDecision(env, decision);
    await handleDecisionSuccess(env);

    return decision;
  } catch (error) {
    await handleDecisionFailure(env, String(error));
    throw error;
  }
}