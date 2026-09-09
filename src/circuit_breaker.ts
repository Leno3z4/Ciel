export type CircuitState = {
  paperCircuitOpen: boolean;
  reason?: string;
  failures: number;
  updatedAt: number;
};

const KEY = "paper_circuit_breaker";

export async function recordFailure(env: { CIEL_STATE: KVNamespace }, reason: string) {
  const raw = await env.CIEL_STATE.get(KEY);
  const current: CircuitState = raw ? JSON.parse(raw) : { paperCircuitOpen:false, failures:0, updatedAt:0 };
  current.failures += 1;
  current.reason = reason;
  current.updatedAt = Date.now();
  if (current.failures >= 3) current.paperCircuitOpen = true;
  await env.CIEL_STATE.put(KEY, JSON.stringify(current));
}

export async function resetCircuit(env: { CIEL_STATE: KVNamespace }) {
  await env.CIEL_STATE.put(KEY, JSON.stringify({paperCircuitOpen:false, failures:0, updatedAt:Date.now()}));
}

export async function isCircuitOpen(env: { CIEL_STATE: KVNamespace }) {
  const raw = await env.CIEL_STATE.get(KEY);
  return raw ? (JSON.parse(raw) as CircuitState).paperCircuitOpen : false;
}
