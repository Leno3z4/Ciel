import { buildBaseline, buildPatternProfile, deviationScore, askGemini, type Snapshot, type GeminiDecision } from "./model";
import type { Env } from "./index";
import { notifyTelegram } from "./telegram";
import { getMarketState } from "./market_discovery";
import { getGeminiPool, nextPoolSlot, type GeminiPool, GEMINI_POOL_LABELS } from "./gemini_router";

const HOT_STATE_KEY = "ciel_hot_intelligence_state";
const PENDING_PREFIX = "ciel_kv_pending_signal:";
const RUNTIME_KEY = "ciel_runtime_state";
const GEMINI_POOL_STATE_KEY = "ciel_gemini_pool_state";
const MAX_HISTORY = 480;
const MAX_MARKETS = 5;
const MIN_HISTORY_SAMPLES = 8;
const MIN_MARKET_CAP_USD = 50_000;
const MIN_LIQUIDITY_USD = 5_000;
const KV_DECISION_COOLDOWN_MS = 30 * 60 * 1000;
const ANALYST_POOL_COOLDOWN_MS = 10 * 60 * 1000;
const DECISION_POOL_COOLDOWN_MS = 3 * 60 * 1000;
const GEMINI_KEY_COOLDOWN_MS = 5 * 60 * 1000;
const RUNTIME_WRITE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;
const MAX_PENDING_SIGNALS_PER_FLUSH = 20;
const ANALYST_MIN_CONFIDENCE = 0.60;
const TRADING_GEMINI_KEY_COUNT = 7;

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

interface GeminiPoolState {
  analystCursor: number;
  decisionCursor: number;
  fallbackCursor: number;
  lastPoolCallAt: Partial<Record<GeminiPool, number>>;
  lastUsedKeyByPool: Partial<Record<GeminiPool, number>>;
}

function emptyHotState(): HotState {
  return { version: 1, updatedTsMs: 0, markets: {}, geminiCursor: 0, geminiKeyCooldowns: {}, lastGeminiDecisionAt: 0 };
}

function emptyGeminiPoolState(): GeminiPoolState {
  return { analystCursor: 0, decisionCursor: 0, fallbackCursor: 0, lastPoolCallAt: {}, lastUsedKeyByPool: {} };
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

async function readPoolState(env: Env): Promise<GeminiPoolState> {
  const raw = await env.CIEL_STATE.get(GEMINI_POOL_STATE_KEY);
  if (!raw) return emptyGeminiPoolState();
  try {
    const parsed = JSON.parse(raw) as Partial<GeminiPoolState>;
    return {
      analystCursor: Math.max(0, Math.floor(num(parsed.analystCursor))),
      decisionCursor: Math.max(0, Math.floor(num(parsed.decisionCursor))),
      fallbackCursor: Math.max(0, Math.floor(num(parsed.fallbackCursor))),
      lastPoolCallAt: parsed.lastPoolCallAt || {},
      lastUsedKeyByPool: parsed.lastUsedKeyByPool || {}
    };
  } catch {
    return emptyGeminiPoolState();
  }
}

async function writePoolState(env: Env, state: GeminiPoolState): Promise<void> {
  await env.CIEL_STATE.put(GEMINI_POOL_STATE_KEY, JSON.stringify(state), { expirationTtl: 172800 });
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

function cursorForPool(state: GeminiPoolState, pool: GeminiPool): number {
  if (pool === "ANALYST") return state.analystCursor;
  if (pool === "DECISION") return state.decisionCursor;
  return state.fallbackCursor;
}

function setCursorForPool(state: GeminiPoolState, pool: GeminiPool, cursor: number): void {
  if (pool === "ANALYST") state.analystCursor = cursor;
  else if (pool === "DECISION") state.decisionCursor = cursor;
  else state.fallbackCursor = cursor;
}

function cooldownForPool(pool: GeminiPool): number {
  if (pool === "ANALYST") return ANALYST_POOL_COOLDOWN_MS;
  if (pool === "DECISION") return DECISION_POOL_COOLDOWN_MS;
  return 0;
}

function isFallbackWorthy(error: unknown): boolean {
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit|401|403|api.?key|permission|timeout|temporar/i.test(String(error));
}

async function callGeminiPool(
  env: Env,
  poolState: GeminiPoolState,
  pool: GeminiPool,
  snapshot: Snapshot,
  baseline: ReturnType<typeof buildBaseline>,
  score: number,
  pattern: ReturnType<typeof buildPatternProfile>
): Promise<{ decision: GeminiDecision; keyIndex: number; fallbacks: number }> {
  const slots = getGeminiPool(env, pool);
  if (!slots.length) throw new Error(`No Gemini keys configured for ${GEMINI_POOL_LABELS[pool]}`);

  const now = Date.now();
  const lastPoolCall = num(poolState.lastPoolCallAt[pool] || 0);
  const poolCooldown = cooldownForPool(pool);
  if (poolCooldown > 0 && lastPoolCall > 0 && now - lastPoolCall < poolCooldown) {
    throw new Error(`${pool.toLowerCase()}_pool_cooldown`);
  }

  let cursor = cursorForPool(poolState, pool);
  let lastError: unknown = new Error(`No usable Gemini key in ${GEMINI_POOL_LABELS[pool]}`);
  let attempts = 0;
  for (let offset = 0; offset < slots.length; offset++) {
    const candidate = nextPoolSlot(pool, slots, cursor);
    if (!candidate) break;
    cursor = candidate.nextCursor;
    const slot = candidate.slot;
    const stateKey = String(slot.index);
    const persistedCooldowns = await env.CIEL_STATE.get(`ciel_gemini_key_cooldown:${stateKey}`);
    if (num(persistedCooldowns) > now) continue;

    attempts++;
    try {
      const role = pool === "DECISION" ? "regime" : "market";
      const decision = await askGemini(slot.key, env.GEMINI_MODEL, role, snapshot, baseline, score, pattern);
      if (!decision) throw new Error("Gemini returned no decision");
      const slotPosition = slots.findIndex(entry => entry.index === slot.index);
      setCursorForPool(poolState, pool, slotPosition >= 0 ? (slotPosition + 1) % slots.length : 0);
      poolState.lastPoolCallAt[pool] = now;
      poolState.lastUsedKeyByPool[pool] = slot.index;
      await writePoolState(env, poolState);
      return { decision, keyIndex: slot.index, fallbacks: Math.max(0, attempts - 1) };
    } catch (error) {
      lastError = error;
      if (!isFallbackWorthy(error)) throw error;
      await env.CIEL_STATE.put(`ciel_gemini_key_cooldown:${stateKey}`, String(now + GEMINI_KEY_COOLDOWN_MS), { expirationTtl: 3600 });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function runKvDecision(env: Env, state: HotState, token: string, item: Record<string, unknown>, history: Snapshot[]): Promise<boolean> {
  if (!meaningfulTrigger(history)) return false;
  const key = token.toLowerCase();
  const market = state.markets[key];
  const now = Date.now();
  if (market && market.decisionCooldownUntil > now) return false;

  const baseline = buildBaseline(history);
  const pattern = buildPatternProfile(history);
  const score = deviationScore(history[0], baseline);
  const poolState = await readPoolState(env);

  let analyst: { decision: GeminiDecision; keyIndex: number; fallbacks: number };
  try {
    analyst = await callGeminiPool(env, poolState, "ANALYST", history[0], baseline, score, pattern);
  } catch (error) {
    if (/analyst_pool_cooldown/.test(String(error))) return false;
    try {
      analyst = await callGeminiPool(env, poolState, "FALLBACK", history[0], baseline, score, pattern);
    } catch (fallbackError) {
      await writeRuntimeThrottled(env, {
        lastGeminiError: `Analyst stage failed: ${String(fallbackError).slice(0, 700)}`,
        lastGeminiPoolFailure: "ANALYST/FALLBACK"
      }, true);
      return false;
    }
  }

  const analystDecision = analyst.decision;
  const analystAction = analystDecision.action === "HOLD" || analystDecision.action === "IGNORE" ? "WAIT" : analystDecision.action;
  const analystPass = (analystAction === "BUY" || analystAction === "SELL") && analystDecision.confidence >= ANALYST_MIN_CONFIDENCE;

  await writeRuntimeThrottled(env, {
    lastGeminiAnalystKey: analyst.keyIndex,
    lastGeminiAnalystAction: analystAction,
    lastGeminiAnalystConfidence: analystDecision.confidence,
    lastGeminiAnalystFallbacks: analyst.fallbacks,
    lastGeminiPool: "ANALYST"
  }, true);

  if (!analystPass) return true;

  let finalResult: { decision: GeminiDecision; keyIndex: number; fallbacks: number };
  try {
    finalResult = await callGeminiPool(env, poolState, "DECISION", history[0], baseline, score, pattern);
  } catch (error) {
    if (/decision_pool_cooldown/.test(String(error))) return true;
    try {
      finalResult = await callGeminiPool(env, poolState, "FALLBACK", history[0], baseline, score, pattern);
    } catch (fallbackError) {
      await writeRuntimeThrottled(env, {
        lastGeminiError: `Decision stage failed: ${String(fallbackError).slice(0, 700)}`,
        lastGeminiPoolFailure: "DECISION/FALLBACK"
      }, true);
      return false;
    }
  }

  const decision = finalResult.decision;
  const decisionAt = Date.now();
  state.geminiCursor = Math.max(0, finalResult.keyIndex - 1);
  state.lastGeminiDecisionAt = decisionAt;
  state.markets[key] = {
    symbol: tokenSymbol(item),
    snapshots: history,
    decisionCooldownUntil: decisionAt + KV_DECISION_COOLDOWN_MS,
    lastDecisionAt: decisionAt
  };

  await writeHotState(env, state);
  await writeRuntimeThrottled(env, {
    lastGeminiSuccess: decisionAt,
    lastGeminiKeyUsed: finalResult.keyIndex,
    lastGeminiFallbacks: finalResult.fallbacks,
    lastModelAnalyzed: decisionAt,
    lastModelDecisionCandidate: token,
    lastModelDecisionAction: decision.action === "HOLD" || decision.action === "IGNORE" ? "WAIT" : decision.action,
    lastModelDecisionConfidence: decision.confidence,
    lastModelError: undefined,
    kvModelActive: true,
    lastModelDecisionKeyPool: TRADING_GEMINI_KEY_COUNT,
    lastGeminiDecisionPool: "DECISION",
    lastGeminiFallbackKeyReserved: 7
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
    kvModelActive: analyzed > 0,
    lastModelDecisionKeyPool: TRADING_GEMINI_KEY_COUNT
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
