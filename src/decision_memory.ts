export type DecisionMemory = {
  token: string;
  decision: "BUY" | "SELL" | "WAIT";
  confidence: number;
  reason: string;
  timestamp: number;
  result?: string;
};

const KEY = "decisions_history";

export async function saveDecision(env: { CIEL_STATE: KVNamespace }, decision: DecisionMemory) {
  const raw = await env.CIEL_STATE.get(KEY);
  const history: DecisionMemory[] = raw ? JSON.parse(raw) : [];
  history.unshift(decision);
  await env.CIEL_STATE.put(KEY, JSON.stringify(history.slice(0, 500)));
}

export async function getRecentDecisions(env: { CIEL_STATE: KVNamespace }, limit = 10) {
  const raw = await env.CIEL_STATE.get(KEY);
  if (!raw) return [];
  return (JSON.parse(raw) as DecisionMemory[]).slice(0, limit);
}
