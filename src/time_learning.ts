export type HourPattern = { samples:number; wins:number; averagePump:number; confidence:number };

export async function recordHourResult(env: {CIEL_STATE: KVNamespace}, hour:number, pump:number) {
  const key = "market_hour_patterns";
  const raw = await env.CIEL_STATE.get(key);
  const data: Record<string, HourPattern> = raw ? JSON.parse(raw) : {};
  const h = String(hour);
  const current = data[h] || {samples:0,wins:0,averagePump:0,confidence:0};
  current.samples++;
  if (pump > 0) current.wins++;
  current.averagePump = ((current.averagePump * (current.samples - 1)) + pump) / current.samples;
  current.confidence = Math.min(1, current.samples / 200);
  data[h] = current;
  await env.CIEL_STATE.put(key, JSON.stringify(data));
}

export async function getHourScore(env:{CIEL_STATE:KVNamespace}, hour:number) {
  const raw = await env.CIEL_STATE.get("market_hour_patterns");
  if (!raw) return 50;
  const data = JSON.parse(raw) as Record<string, HourPattern>;
  const pattern = data[String(hour)];
  if (!pattern) return 50;
  return Math.round((pattern.wins / Math.max(pattern.samples,1)) * 100 * pattern.confidence);
}
