import { prepareGeminiContext, recordGeminiDecision, checkDecisionHealth, handleDecisionFailure, handleDecisionSuccess } from "./intelligence_pipeline";

export type CielDecision = {
  token: string;
  action: "BUY" | "SELL" | "WAIT";
  confidence?: number;
  rationale?: string;
};

/**
 * Shared orchestration wrapper for decision cycles.
 * Keeps intelligence preparation, circuit protection and decision memory
 * outside the executor.
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

    await recordGeminiDecision(env, decision);
    await handleDecisionSuccess(env);

    return decision;
  } catch (error) {
    await handleDecisionFailure(env, String(error));
    throw error;
  }
}
