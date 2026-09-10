import { buildBaseline, buildPatternProfile, deviationScore, askGemini, type Snapshot } from "./model";
import type { Env } from "./index";
import { notifyTelegram } from "./telegram";

const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const MON_USD_KEY = "mon_usd";
const HISTORY_PREFIX = "ciel_kv_history:";
const PENDING_PREFIX = "ciel_kv_pending_signal:";
const RUNTIME_KEY = "ciel_runtime_state";
const MAX_HISTORY = 24;
const MAX_MARKETS = 5;
const KV_COOLDOWN_MS = 10 * 60 * 1000;
const MIN_MARKET_CAP_USD = 50_000;
const MIN_LIQUIDITY_USD = 5_000;

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const text = value.trim().replace(/[$,\s]/g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return null;
  const object = source as Record<string, unknown>;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return null;
}

function extractTokens(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return value.filter(x => x && typeof x === "object") as Array<Record<string, unknown>>;
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokens(object[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function tokenAddress(item: Record<string, unknown>): string | null {
  const value = objectValue(item.token_info, ["token_id", "token_address", "tokenAddress"]) ||
    objectValue(item.market_info, ["token_id", "token_address", "tokenAddress"]);
  const text = typeof value === "string" ? value.trim() : "";
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text : null;
}

function tokenSymbol(item: Record<string, unknown>): string {
  const value = objectValue(item.token_info, ["symbol"]);
  return typeof value === "string" && value.trim() ? value.trim() : (tokenAddress(item)?.slice(0, 10) || "unknown");
}

function marketCap(item: Record<string, unknown>): number {
  return num(objectValue(item.market_info, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv", "fully_diluted_valuation"])) ||
    num(objectValue(item.token_info, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv", "fully_diluted_valuation"]));
}

function priceUsd(item: Record<string, unknown>): number {
  return num(objectValue(item.market_info, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"])) ||
    num(objectValue(item.token_info, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"]));
}

function liquidityUsd(item: Record<string, unknown>, monUsd: number): number {
  const direct = num(objectValue(item.market_info, ["liquidity_usd", "liquidityUsd"])) ||
    num(objectValue(item.token_info, ["liquidity_usd", "liquidityUsd"]));
  if (direct > 0) return direct;
  const reserve = num(objectValue(item.market_info, ["reserve_native"])) || num(objectValue(item.token_info, ["reserve_native"]));
  return reserve > 0 && monUsd > 0 ? reserve / 1e18 * monUsd : 0;
}

function volume5mUsd(item: Record<string, unknown>, monUsd: number): number {
  const direct = num(objectValue(item.market_info, ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"])) ||
    num(objectValue(item.token_info, ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"]));
  if (direct > 0) return direct;
  const raw = num(objectValue(item.market_info, ["volume_5m", "volume5m", "volume"]));
  return raw > 0 && monUsd > 0 ? (raw >= 1e15 ? raw / 1e18 * monUsd : raw * monUsd) : 0;
}

async function readRuntime(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function writeRuntime(env: Env, patch: Record<string, unknown>): Promise<void> {
  const current = await readRuntime(env);
  await env.CIEL_STATE.put(RUNTIME_KEY, JSON.stringify({ ...current, ...patch }));
}

async function readFeed(env: Env): Promise<Array<Record<string, unknown>>> {
  const raw = await env.CIEL_STATE.get(RANKING_CACHE_KEY);
  if (!raw) return [];
  try {
    return extractTokens(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function appendHistory(env: Env, snapshot: Snapshot): Promise<Snapshot[]> {
  const key = `${HISTORY_PREFIX}${snapshot.token.toLowerCase()}`;
  const raw = await env.CIEL_STATE.get(key);
  let history: Snapshot[] = [];
  try { history = raw ? JSON.parse(raw) as Snapshot[] : []; } catch {}
  history = history.filter(row => Number(row.tsMs) > 0 && Number(row.marketCapUsd) > 0);
  history.push(snapshot);
  history = history.sort((a, b) => Number(b.tsMs) - Number(a.tsMs)).slice(0, MAX_HISTORY);
  await env.CIEL_STATE.put(key, JSON.stringify(history), { expirationTtl: 172800 });
  return history;
}

async function loadHistory(env: Env, token: string): Promise<Snapshot[]> {
  const raw = await env.CIEL_STATE.get(`${HISTORY_PREFIX}${token.toLowerCase()}`);
  if (!raw) return [];
  try { return JSON.parse(raw) as Snapshot[]; } catch { return []; }
}

async function runKvDecision(env: Env, token: string, item: Record<string, unknown>, history: Snapshot[], monUsd: number): Promise<void> {
  if (history.length < 4) return;
  const current = history[0];
  const baseline = buildBaseline(history);
  const pattern = buildPatternProfile(history);
  const score = deviationScore(current, baseline);
  const keys = [
    env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5, env.GEMINI_API_KEY_6,
    env.GEMINI_API_KEY_7
  ].map(value => (value || "").trim()).filter(Boolean);
  if (!keys.length) return;

  const cooldownKey = `ciel_kv_decision_cooldown:${token.toLowerCase()}`;
  const last = Number(await env.CIEL_STATE.get(cooldownKey) || "0");
  if (last > 0 && Date.now() - last < KV_COOLDOWN_MS) return;

  let decision = null;
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      decision = await askGemini(key, env.GEMINI_MODEL, "market", current, baseline, score, pattern);
      if (decision) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!decision) {
    await writeRuntime(env, { lastGeminiError: `KV decision failed: ${String(lastError || "unknown error").slice(0, 700)}` });
    return;
  }

  await env.CIEL_STATE.put(cooldownKey, String(Date.now()), { expirationTtl: 3600 });
  await writeRuntime(env, {
    lastGeminiSuccess: Date.now(),
    lastModelAnalyzed: Date.now(),
    lastModelDecisionCandidate: token,
    lastModelDecisionAction: decision.action === "HOLD" || decision.action === "IGNORE" ? "WAIT" : decision.action,
    lastModelDecisionConfidence: decision.confidence,
    lastModelError: undefined,
    kvModelActive: true
  });

  if (decision.action !== "BUY" && decision.action !== "SELL") return;

  const pending = {
    token,
    action: decision.action,
    confidence: decision.confidence,
    rationale: decision.rationale,
    expectedLowUsd: decision.expectedLowUsd,
    expectedHighUsd: decision.expectedHighUsd,
    anomalyScore: decision.anomalyScore,
    regime: decision.regime,
    marketCapUsd: current.marketCapUsd,
    liquidityUsd: current.liquidityUsd,
    createdTsMs: Date.now(),
    status: "PENDING_D1"
  };

  await env.CIEL_STATE.put(
    `${PENDING_PREFIX}${token.toLowerCase()}`,
    JSON.stringify(pending),
    { expirationTtl: 86400 }
  );

  await notifyTelegram(
    env,
    `${decision.action === "BUY" ? "🟢" : "🔴"} CIEL KV ${decision.action} SIGNAL\n${tokenSymbol(item)} (${token.slice(0, 10)}…)\nConfidence: ${(decision.confidence * 100).toFixed(0)}%\nRegime: ${decision.regime}\nStatus: queued for D1 execution ledger\nReason: ${decision.rationale}`
  );
}

export async function runKvIntelligenceCycle(env: Env): Promise<void> {
  const feed = await readFeed(env);
  const monUsd = Number(await env.CIEL_STATE.get(MON_USD_KEY) || "0");
  const candidates = feed
    .map(item => ({ item, token: tokenAddress(item), marketCap: marketCap(item), liquidity: liquidityUsd(item, monUsd) }))
    .filter(row => row.token && row.marketCap >= MIN_MARKET_CAP_USD && row.liquidity >= MIN_LIQUIDITY_USD)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, MAX_MARKETS);

  let analyzed = 0;
  for (const row of candidates) {
    if (!row.token) continue;
    const snapshot: Snapshot = {
      token: row.token,
      tsMs: Date.now(),
      priceUsd: priceUsd(row.item),
      marketCapUsd: row.marketCap,
      liquidityUsd: row.liquidity,
      volume5mUsd: volume5mUsd(row.item, monUsd),
      buys5m: 0,
      sells5m: 0,
      holders: num(objectValue(row.item.token_info, ["holder_count", "holderCount", "holders"]))
    };
    const history = await appendHistory(env, snapshot);
    await runKvDecision(env, row.token, row.item, history, monUsd);
    analyzed++;
  }

  await writeRuntime(env, {
    lastKvIntelligenceRun: Date.now(),
    lastKvIntelligenceAnalyzed: analyzed,
    lastKvIntelligenceCandidates: candidates.length
  });
}
