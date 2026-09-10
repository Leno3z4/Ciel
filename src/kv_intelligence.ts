import { buildBaseline, buildPatternProfile, deviationScore, askGemini, type Snapshot } from "./model";
import type { Env } from "./index";
import { notifyTelegram } from "./telegram";
import { getMarketState } from "./market_discovery";

const HOT_STATE_KEY = "ciel_hot_intelligence_state";
const PENDING_PREFIX = "ciel_kv_pending_signal:";
const RUNTIME_KEY = "ciel_runtime_state";
const GEMINI_GLOBAL_CALL_KEY = "ciel_gemini_last_global_call_ms";
const MAX_HISTORY = 480;
const MAX_MARKETS = 5;
const MIN_HISTORY_SAMPLES = 8;
const MIN_MARKET_CAP_USD = 50_000;
const MIN_LIQUIDITY_USD = 5_000;
const KV_DECISION_COOLDOWN_MS = 30 * 60 * 1000;
const GEMINI_GLOBAL_MIN_INTERVAL_MS = 15 * 60 * 1000;
const GEMINI_KEY_COOLDOWN_MS = 30 * 60 * 1000;
const RUNTIME_WRITE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;
const MAX_PENDING_SIGNALS_PER_FLUSH = 20;

interface HotMarketState {
  symbol: string;
  snapshots: Snapshot[];
  decisionCooldownUntil: number;
  lastDecisionAt: number;
}

interface HotState {
  version: 1;
  updatedTsMs: number;
  markets: Record<string, HotMarketState>;
  geminiCursor: number;
  geminiKeyCooldowns: Record<string, number>;
  lastGeminiDecisionAt: number;
}

function emptyHotState(): HotState {
  return {
    version: 1,
    updatedTsMs: 0,
    markets: {},
    geminiCursor: 0,
    geminiKeyCooldowns: {},
    lastGeminiDecisionAt: 0
  };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readHotState(env: Env): Promise<HotState> {
  const raw = await env.CIEL_STATE.get(HOT_STATE_KEY);
  if (!raw) return emptyHotState();
  try {
    const parsed = JSON.parse(raw) as Partial<HotState>;
    if (!parsed || typeof parsed !== "object" || !parsed.markets || typeof parsed.markets !== "object") return emptyHotState();
    return {
      version: 1,
      updatedTsMs: num(parsed.updatedTsMs),
      markets: parsed.markets as Record<string, HotMarketState>,
      geminiCursor: Math.max(0, Math.floor(num(parsed.geminiCursor))),
      geminiKeyCooldowns: parsed.geminiKeyCooldowns || {},
      lastGeminiDecisionAt: num(parsed.lastGeminiDecisionAt)
    };
  } catch {
    return emptyHotState();
  }
}

async function writeHotState(env: Env, state: HotState): Promise<void> {
  state.updatedTsMs = Date.now();
  await env.CIEL_STATE.put(HOT_STATE_KEY, JSON.stringify(state), { expirationTtl: 172800 });
}

async function readRuntime(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function writeRuntimeThrottled(env: Env, patch: Record<string, unknown>, force = false): Promise<void> {
  const current = await readRuntime(env);
  const last = num(current.lastKvRuntimeWrite || 0);
  if (!force && last > 0 && Date.now() - last < RUNTIME_WRITE_INTERVAL_MS) return;
  await env.CIEL_STATE.put(RUNTIME_KEY, JSON.stringify({ ...current, ...patch, lastKvRuntimeWrite: Date.now() }), { expirationTtl: 172800 });
}

function tokenAddress(item: Record<string, unknown>): string | null {
  const tokenInfo = item.token_info;
  const marketInfo = item.market_info;
  const values = [
    tokenInfo && typeof tokenInfo === "object" ? (tokenInfo as Record<string, unknown>).token_id : null,
    marketInfo && typeof marketInfo === "object" ? (marketInfo as Record<string, unknown>).token_id : null
  ];
  for (const value of values) {
    if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim())) return value.trim();
  }
  return null;
}

function tokenSymbol(item: Record<string, unknown>): string {
  const tokenInfo = item.token_info;
  const value = tokenInfo && typeof tokenInfo === "object" ? (tokenInfo as Record<string, unknown>).symbol : null;
  return typeof value === "string" && value.trim() ? value.trim() : tokenAddress(item)?.slice(0, 10) || "unknown";
}

function numberFrom(item: Record<string, unknown>, keys: string[]): number {
  const sources = [item.market_info, item.token_info, item];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const object = source as Record<string, unknown>;
    for (const key of keys) {
      const value = num(object[key]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function marketCap(item: Record<string, unknown>): number {
  return numberFrom(item, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv", "fully_diluted_valuation"]);
}

function priceUsd(item: Record<string, unknown>): number {
  return numberFrom(item, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"]);
}

function liquidityUsd(item: Record<string, unknown>): number {
  return numberFrom(item, ["liquidity_usd", "liquidityUsd"]);
}

function volume5mUsd(item: Record<string, unknown>): number {
  return numberFrom(item, ["volume_5m_usd", "volume5mUsd", "volume_usd_5m", "volume_5m", "volume5m", "volume"]);
}

function snapshotFor(item: Record<string, unknown>, token: string, now: number): Snapshot {
  return {
    token,
    tsMs: now,
    priceUsd: priceUsd(item),
    marketCapUsd: marketCap(item),
    liquidityUsd: liquidityUsd(item),
    volume5mUsd: volume5mUsd(item),
    buys5m: 0,
    sells5m: 0,
    holders: numberFrom(item, ["holder_count", "holderCount", "holders"])
  };
}

function meaningfulTrigger(history: Snapshot[]): boolean {
  if (history.length < MIN_HISTORY_SAMPLES) return false;
  const pattern = buildPatternProfile(history);
  const behavior = pattern.priceBehavior;
  const improving = pattern.currentMarketCapReturn30mPct >= 2 && pattern.volumeVsBaseline >= 1.15;
  const enteringLow = behavior.currentZone === "LOW" && pattern.currentMarketCapReturn30mPct >= -5;
  const strongTrend = pattern.currentMarketCapReturn30mPct >= 8 && pattern.volumeVsBaseline >= 1.25;
  return (enteringLow && improving) || strongTrend;
}

async function runKvDecision(env: Env, state: HotState, token: string, item: Record<string, unknown>, history: Snapshot[]): Promise<boolean> {
  if (!meaningfulTrigger(history)) return false;
  const key = token.toLowerCase();
  const market = state.markets[key];
  if (market && market.decisionCooldownUntil > Date.now()) return false;
  const sharedLast = num(await env.CIEL_STATE.get(GEMINI_GLOBAL_CALL_KEY) || "0");
  if (sharedLast > 0 && Date.now() - sharedLast < GEMINI_GLOBAL_MIN_INTERVAL_MS) return false;
  if (state.lastGeminiDecisionAt > 0 && Date.now() - state.lastGeminiDecisionAt < GEMINI_GLOBAL_MIN_INTERVAL_MS) return false;

  const keys = [
    env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5, env.GEMINI_API_KEY_6,
    env.GEMINI_API_KEY_7
  ].map(value => (value || "").trim()).filter(Boolean);
  if (!keys.length) return false;

  const baseline = buildBaseline(history);
  const pattern = buildPatternProfile(history);
  const score = deviationScore(history[0], baseline);
  const cursor = state.geminiCursor % keys.length;
  let decision = null;
  let lastError: unknown = null;
  let usedSlot = -1;

  for (let offset = 0; offset < keys.length; offset++) {
    const index = (cursor + offset) % keys.length;
    const cooldownUntil = num(state.geminiKeyCooldowns[String(index + 1)] || 0);
    if (cooldownUntil > Date.now()) continue;
    try {
      decision = await askGemini(keys[index], env.GEMINI_MODEL, "market", history[0], baseline, score, pattern);
      usedSlot = index + 1;
      break;
    } catch (error) {
      lastError = error;
      if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(String(error))) {
        state.geminiKeyCooldowns[String(index + 1)] = Date.now() + GEMINI_KEY_COOLDOWN_MS;
        continue;
      }
      break;
    }
  }

  if (!decision || usedSlot < 0) {
    if (lastError) await writeRuntimeThrottled(env, { lastGeminiError: `KV decision failed: ${String(lastError).slice(0, 700)}` }, true);
    return false;
  }

  const decisionAt = Date.now();
  state.geminiCursor = usedSlot % keys.length;
  state.lastGeminiDecisionAt = decisionAt;
  state.markets[key] = {
    symbol: tokenSymbol(item),
    snapshots: history,
    decisionCooldownUntil: decisionAt + KV_DECISION_COOLDOWN_MS,
    lastDecisionAt: decisionAt
  };

  await env.CIEL_STATE.put(GEMINI_GLOBAL_CALL_KEY, String(decisionAt), { expirationTtl: 172800 });
  await writeRuntimeThrottled(env, {
    lastGeminiSuccess: decisionAt,
    lastGeminiKeyUsed: usedSlot,
    lastGeminiFallbacks: Math.max(0, usedSlot - cursor - 1),
    lastModelAnalyzed: decisionAt,
    lastModelDecisionCandidate: token,
    lastModelDecisionAction: decision.action === "HOLD" || decision.action === "IGNORE" ? "WAIT" : decision.action,
    lastModelDecisionConfidence: decision.confidence,
    lastModelError: undefined,
    kvModelActive: true
  }, true);

  if (decision.action !== "BUY" && decision.action !== "SELL") return true;

  const pending = {
    token,
    action: decision.action,
    confidence: decision.confidence,
    rationale: decision.rationale,
    expectedLowUsd: decision.expectedLowUsd,
    expectedHighUsd: decision.expectedHighUsd,
    anomalyScore: decision.anomalyScore,
    regime: decision.regime,
    marketCapUsd: history[0].marketCapUsd,
    liquidityUsd: history[0].liquidityUsd,
    createdTsMs: decisionAt,
    status: "PENDING_D1"
  };
  await env.CIEL_STATE.put(`${PENDING_PREFIX}${key}`, JSON.stringify(pending), { expirationTtl: 86400 });
  await notifyTelegram(env, `${decision.action === "BUY" ? "🟢" : "🔴"} CIEL KV ${decision.action} SIGNAL\n${tokenSymbol(item)} (${token.slice(0, 10)}…)\nConfidence: ${(decision.confidence * 100).toFixed(0)}%\nRegime: ${decision.regime}\nStatus: queued for D1 execution ledger\nReason: ${decision.rationale}`);
  return true;
}

export async function runKvIntelligenceCycle(env: Env): Promise<void> {
  const marketState = await getMarketState(env);
  if (!marketState || !marketState.tokens.length) return;

  const state = await readHotState(env);
  const now = Date.now();
  const candidates = marketState.tokens
    .map(item => ({ item, token: tokenAddress(item), marketCap: marketCap(item), liquidity: liquidityUsd(item) }))
    .filter(row => row.token && row.marketCap >= MIN_MARKET_CAP_USD && row.liquidity >= MIN_LIQUIDITY_USD)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, MAX_MARKETS);

  let analyzed = 0;
  let geminiTriggered = false;
  for (const row of candidates) {
    if (!row.token) continue;
    const key = row.token.toLowerCase();
    const previous = state.markets[key]?.snapshots || [];
    const snapshot = snapshotFor(row.item, row.token, now);
    const history = [snapshot, ...previous].sort((a, b) => b.tsMs - a.tsMs).slice(0, MAX_HISTORY);
    state.markets[key] = {
      symbol: tokenSymbol(row.item),
      snapshots: history,
      decisionCooldownUntil: state.markets[key]?.decisionCooldownUntil || 0,
      lastDecisionAt: state.markets[key]?.lastDecisionAt || 0
    };
    analyzed++;
    if (!geminiTriggered) geminiTriggered = await runKvDecision(env, state, row.token, row.item, history);
  }

  const cutoff = now - 26 * 60 * 60 * 1000;
  for (const [token, market] of Object.entries(state.markets)) {
    const newest = Math.max(...(market.snapshots || []).map(row => row.tsMs), 0);
    if (newest < cutoff) delete state.markets[token];
  }

  await writeHotState(env, state);
  await writeRuntimeThrottled(env, {
    lastKvIntelligenceRun: now,
    lastKvIntelligenceAnalyzed: analyzed,
    lastKvIntelligenceCandidates: candidates.length,
    kvModelActive: analyzed > 0
  });
}

export async function flushPendingKvSignals(env: Env): Promise<void> {
  const pendingList = await env.CIEL_STATE.list({ prefix: PENDING_PREFIX, limit: MAX_PENDING_SIGNALS_PER_FLUSH });
  if (!pendingList.keys.length) return;

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_positions (token_address TEXT PRIMARY KEY, quantity TEXT NOT NULL, entry_price_usd REAL, entry_ts_ms INTEGER, last_price_usd REAL, updated_ts_ms INTEGER NOT NULL)`).run();
  const marketState = await getMarketState(env);
  const feedByToken = new Map<string, Record<string, unknown>>();
  for (const item of marketState?.tokens || []) {
    const token = tokenAddress(item);
    if (token) feedByToken.set(token.toLowerCase(), item);
  }

  let queued = 0;
  let discarded = 0;
  for (const key of pendingList.keys) {
    const token = key.name.slice(PENDING_PREFIX.length).toLowerCase();
    const raw = await env.CIEL_STATE.get(key.name);
    if (!raw) continue;
    let pending: Record<string, unknown>;
    try { pending = JSON.parse(raw) as Record<string, unknown>; } catch { await env.CIEL_STATE.delete(key.name); discarded++; continue; }
    const createdTsMs = num(pending.createdTsMs);
    const action = String(pending.action || "").toUpperCase();
    const confidence = num(pending.confidence);
    const item = feedByToken.get(token);

    if (!createdTsMs || Date.now() - createdTsMs > MAX_PENDING_AGE_MS || !item || !["BUY", "SELL"].includes(action) || confidence < 0.48) {
      await env.CIEL_STATE.delete(key.name);
      discarded++;
      continue;
    }

    const currentMarketCap = marketCap(item);
    const currentLiquidity = liquidityUsd(item);
    const currentPrice = priceUsd(item);
    if (currentMarketCap < MIN_MARKET_CAP_USD || currentLiquidity < MIN_LIQUIDITY_USD || currentPrice <= 0) {
      await env.CIEL_STATE.delete(key.name);
      discarded++;
      continue;
    }

    const position = await env.DB.prepare("SELECT quantity FROM live_positions WHERE token_address=? AND quantity<>'0'").bind(token).first<{ quantity: string }>();
    if ((action === "BUY" && position) || (action === "SELL" && !position)) {
      await env.CIEL_STATE.delete(key.name);
      discarded++;
      continue;
    }

    const recentDuplicate = await env.DB.prepare(`SELECT id FROM signals WHERE token_address=? AND action=? AND ts_ms>=? ORDER BY ts_ms DESC LIMIT 1`).bind(token, action, Date.now() - 30 * 60 * 1000).first<{ id: number }>();
    if (recentDuplicate) {
      await env.CIEL_STATE.delete(key.name);
      discarded++;
      continue;
    }

    await env.DB.prepare(`INSERT INTO signals(token_address, ts_ms, action, confidence, expected_low, expected_high, anomaly_score, model, rationale) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      token,
      Date.now(),
      action,
      confidence,
      num(pending.expectedLowUsd),
      num(pending.expectedHighUsd),
      num(pending.anomalyScore),
      "gemini-kv-recovery",
      `${String(pending.regime || "UNKNOWN")}: ${String(pending.rationale || "KV signal recovered after D1 degradation")}`
    ).run();

    await env.CIEL_STATE.delete(key.name);
    queued++;
  }

  await writeRuntimeThrottled(env, { lastKvPendingFlush: Date.now(), lastKvPendingQueued: queued, lastKvPendingDiscarded: discarded }, true);
  if (queued > 0 || discarded > 0) await notifyTelegram(env, `🔄 CIEL KV SIGNAL RECOVERY\nQueued for live ledger: ${queued}\nDiscarded stale/invalid: ${discarded}\nD1 execution path is active again.`);
}
