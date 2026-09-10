import {
  publicClient,
  quoteSell,
  sellToNative,
  tokenBalance,
  walletAddress
} from "./nadfun";
import { buildPatternProfile, type Snapshot } from "./model";
import { notifyTelegram } from "./telegram";
import type { Env } from "./index";

const LIVE_POSITIONS_HOT_KEY = "ciel_live_positions_hot";
const EMERGENCY_QUEUE_KEY = "ciel_emergency_exit_queue";
const EMERGENCY_MARKER_PREFIX = "ciel_emergency_exit:";
const EXIT_LOCK_PREFIX = "ciel_live_exit_lock:";
const HOT_STATE_KEY = "ciel_hot_intelligence_state";
const MARKET_STATE_KEY = "ciel_market_state";
const GUARD_RUNTIME_KEY = "ciel_runtime_state";
const EXIT_LOCK_TTL_SECONDS = 180;
const EMERGENCY_MARKER_TTL_SECONDS = 86400;
const DEFAULT_HARD_STOP_PCT = -20;
const DEFAULT_RAPID_CRASH_PCT = -10;
const DEFAULT_RAPID_CRASH_WINDOW_MS = 3 * 60 * 1000;
const DEFAULT_TAKE_PROFIT_PCT = 20;
const DEFAULT_TRAILING_ACTIVATION_PCT = 15;
const DEFAULT_TRAILING_DRAWDOWN_PCT = 7;
const DEFAULT_HIGH_ZONE_PROFIT_PCT = 10;
const DEFAULT_EMERGENCY_SLIPPAGE_BPS = 1000;
const MAX_GUARD_POSITIONS = 10;

export interface LivePositionMirror {
  token: string;
  quantity: string;
  entryPriceUsd: number;
  entryTsMs: number;
  highWaterPriceUsd: number;
  lastPriceUsd: number;
  lastCheckedTsMs: number;
}

interface HotIntelligenceState {
  version?: number;
  updatedTsMs?: number;
  markets?: Record<string, { symbol?: string; snapshots?: Snapshot[] }>;
}

interface MarketState {
  tokens?: unknown;
  normalized?: unknown;
  monUsd?: number;
  fetchedAt?: number;
}

type GuardEnv = Env & {
  LIVE_HARD_STOP_PCT?: string;
  LIVE_RAPID_CRASH_PCT?: string;
  LIVE_TAKE_PROFIT_PCT?: string;
  LIVE_TRAILING_ACTIVATION_PCT?: string;
  LIVE_TRAILING_DRAWDOWN_PCT?: string;
  LIVE_HIGH_ZONE_PROFIT_PCT?: string;
  LIVE_EMERGENCY_SLIPPAGE_BPS?: string;
};

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveQuantity(quantity: string): bigint {
  try {
    const value = BigInt(quantity);
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
}

async function readPositions(env: GuardEnv): Promise<LivePositionMirror[]> {
  const raw = await env.CIEL_STATE.get(LIVE_POSITIONS_HOT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item === "object").map(item => item as LivePositionMirror).slice(0, MAX_GUARD_POSITIONS);
  } catch {
    return [];
  }
}

async function writePositions(env: GuardEnv, positions: LivePositionMirror[]): Promise<void> {
  await env.CIEL_STATE.put(
    LIVE_POSITIONS_HOT_KEY,
    JSON.stringify(positions.slice(0, MAX_GUARD_POSITIONS)),
    { expirationTtl: 172800 }
  );
}

export async function upsertLivePositionMirror(env: GuardEnv, position: Omit<LivePositionMirror, "highWaterPriceUsd" | "lastPriceUsd" | "lastCheckedTsMs">): Promise<void> {
  const positions = await readPositions(env);
  const index = positions.findIndex(item => item.token.toLowerCase() === position.token.toLowerCase());
  const existing = index >= 0 ? positions[index] : null;
  const next: LivePositionMirror = {
    token: position.token,
    quantity: position.quantity,
    entryPriceUsd: position.entryPriceUsd,
    entryTsMs: position.entryTsMs,
    highWaterPriceUsd: Math.max(existing?.highWaterPriceUsd || 0, position.entryPriceUsd),
    lastPriceUsd: position.entryPriceUsd,
    lastCheckedTsMs: Date.now()
  };
  if (index >= 0) positions[index] = next;
  else positions.push(next);
  await writePositions(env, positions);
}

export async function removeLivePositionMirror(env: GuardEnv, token: string): Promise<void> {
  const positions = await readPositions(env);
  const filtered = positions.filter(item => item.token.toLowerCase() !== token.toLowerCase());
  if (filtered.length !== positions.length) await writePositions(env, filtered);
}

export async function hasEmergencyExitMarker(env: GuardEnv, token: string): Promise<boolean> {
  return Boolean(await env.CIEL_STATE.get(`${EMERGENCY_MARKER_PREFIX}${token.toLowerCase()}`));
}

async function readHotHistory(env: GuardEnv, token: string): Promise<Snapshot[]> {
  const raw = await env.CIEL_STATE.get(HOT_STATE_KEY);
  if (!raw) return [];
  try {
    const state = JSON.parse(raw) as HotIntelligenceState;
    const rows = state.markets?.[token.toLowerCase()]?.snapshots;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function readMonUsd(env: GuardEnv): Promise<number> {
  const stateRaw = await env.CIEL_STATE.get(MARKET_STATE_KEY);
  if (stateRaw) {
    try {
      const state = JSON.parse(stateRaw) as MarketState;
      const value = num(state.monUsd);
      if (value > 0) return value;
    } catch {}
  }

  const runtimeRaw = await env.CIEL_STATE.get(GUARD_RUNTIME_KEY);
  if (runtimeRaw) {
    try {
      const runtime = JSON.parse(runtimeRaw) as Record<string, unknown>;
      const value = num(runtime.monUsd);
      if (value > 0) return value;
    } catch {}
  }

  return Number(await env.CIEL_STATE.get("mon_usd") || "0");
}

function minimumOut(quote: bigint, slippageBps: number): bigint {
  const safeBps = Math.min(9000, Math.max(0, Math.floor(slippageBps)));
  return quote * BigInt(10_000 - safeBps) / 10_000n;
}

async function enqueueEmergencyExit(env: GuardEnv, event: Record<string, unknown>): Promise<void> {
  const raw = await env.CIEL_STATE.get(EMERGENCY_QUEUE_KEY);
  let queue: Array<Record<string, unknown>> = [];
  try {
    queue = raw ? JSON.parse(raw) as Array<Record<string, unknown>> : [];
    if (!Array.isArray(queue)) queue = [];
  } catch {}

  queue.push(event);
  queue = queue.slice(-20);
  await env.CIEL_STATE.put(
    EMERGENCY_QUEUE_KEY,
    JSON.stringify(queue),
    { expirationTtl: 604800 }
  );
}

function decisionReason(pnlPct: number, price: number, position: LivePositionMirror, pattern: ReturnType<typeof buildPatternProfile>): string | null {
  const hardStopPct = envNumber((globalThis as Record<string, unknown>).__cielHardStopPct, DEFAULT_HARD_STOP_PCT);
  if (pnlPct <= hardStopPct) return `hard stop ${pnlPct.toFixed(2)}%`;
  if (position.lastPriceUsd > 0 && position.lastCheckedTsMs > 0) {
    const elapsed = Date.now() - position.lastCheckedTsMs;
    if (elapsed <= DEFAULT_RAPID_CRASH_WINDOW_MS && price <= position.lastPriceUsd * (1 + envNumber((globalThis as Record<string, unknown>).__cielRapidCrashPct, DEFAULT_RAPID_CRASH_PCT) / 100)) {
      return `rapid crash ${((price / position.lastPriceUsd - 1) * 100).toFixed(2)}%`;
    }
  }
  const behavior = pattern.priceBehavior;
  const highZone = behavior.currentZone === "HIGH";
  const highLevel = behavior.avgHighPrice12h > 0 ? behavior.avgHighPrice12h : behavior.avgHighPrice24h;
  const nearHistoricalHigh = highLevel > 0 && price >= highLevel * 0.95;
  const takeProfitPct = envNumber((globalThis as Record<string, unknown>).__cielTakeProfitPct, DEFAULT_TAKE_PROFIT_PCT);
  if (pnlPct >= takeProfitPct && (highZone || nearHistoricalHigh || pattern.regimeHint === "DISTRIBUTION")) return `take profit ${pnlPct.toFixed(2)}%`;
  const trailingActivationPct = envNumber((globalThis as Record<string, unknown>).__cielTrailingActivationPct, DEFAULT_TRAILING_ACTIVATION_PCT);
  const trailingDrawdownPct = envNumber((globalThis as Record<string, unknown>).__cielTrailingDrawdownPct, DEFAULT_TRAILING_DRAWDOWN_PCT);
  if (pnlPct >= trailingActivationPct && position.highWaterPriceUsd > 0) {
    const fromHighWaterPct = ((price - position.highWaterPriceUsd) / position.highWaterPriceUsd) * 100;
    if (fromHighWaterPct <= -Math.abs(trailingDrawdownPct)) return `trailing profit protection ${fromHighWaterPct.toFixed(2)}% from high-water`;
  }
  const highZoneProfitPct = envNumber((globalThis as Record<string, unknown>).__cielHighZoneProfitPct, DEFAULT_HIGH_ZONE_PROFIT_PCT);
  if (pnlPct >= highZoneProfitPct && highZone && behavior.currentMinutesInZone >= Math.max(5, behavior.avgMinutesNearHigh12h * 0.75)) return `historical high-zone profit exit ${pnlPct.toFixed(2)}%`;
  return null;
}

async function emergencySell(env: GuardEnv, position: LivePositionMirror, priceUsd: number, reason: string, monUsd: number, balance: bigint, quote: bigint): Promise<boolean> {
  if (!env.WALLET_PRIVATE_KEY || !env.NAD_RPC_URL) return false;
  const token = position.token.toLowerCase();
  const lockKey = `${EXIT_LOCK_PREFIX}${token}`;
  if (await env.CIEL_STATE.get(lockKey)) return false;
  await env.CIEL_STATE.put(lockKey, String(Date.now()), { expirationTtl: EXIT_LOCK_TTL_SECONDS });
  await env.CIEL_STATE.put(`${EMERGENCY_MARKER_PREFIX}${token}`, reason, { expirationTtl: EMERGENCY_MARKER_TTL_SECONDS });

  try {
    const slippageBps = envNumber(env.LIVE_EMERGENCY_SLIPPAGE_BPS, DEFAULT_EMERGENCY_SLIPPAGE_BPS);
    const amountOutMin = minimumOut(quote, slippageBps);
    const txHash = await sellToNative({
      rpcUrl: env.NAD_RPC_URL,
      privateKey: env.WALLET_PRIVATE_KEY,
      token: position.token as `0x${string}`,
      amountIn: balance,
      amountOutMin,
      deadlineSeconds: 30
    });

    const receipt = await publicClient(env.NAD_RPC_URL).waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`emergency SELL reverted: ${txHash}`);

    const proceedsMon = Number(quote) / 1e18;
    const quantity = Number(balance) / 1e18;
    const exitPriceUsd = quantity > 0 && monUsd > 0 ? proceedsMon * monUsd / quantity : priceUsd;
    const now = Date.now();

    await removeLivePositionMirror(env, position.token);
    await enqueueEmergencyExit(env, {
      token: position.token,
      quantity: balance.toString(),
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd,
      txHash,
      tsMs: now,
      reason,
      status: "PENDING_D1_RECONCILIATION"
    });

    await notifyTelegram(
      env,
      `🚨 CIEL LIVE EMERGENCY SELL\nToken: ${position.token}\nPnL at trigger: ${(((priceUsd - position.entryPriceUsd) / Math.max(position.entryPriceUsd, 0.0000000000000001)) * 100).toFixed(2)}%\nReason: ${reason}\nTX: ${txHash}\nD1 ledger reconciliation: queued`
    );

    return true;
  } catch (error) {
    await notifyTelegram(env, `🛑 CIEL LIVE EXIT FAILED\nToken: ${position.token}\nReason: ${reason}\nError: ${String(error).slice(0, 700)}`);
    return false;
  } finally {
    await env.CIEL_STATE.delete(lockKey);
  }
}

async function monitorOnePosition(env: GuardEnv, position: LivePositionMirror, client: ReturnType<typeof publicClient>, monUsd: number): Promise<{ checked: boolean; exited: boolean; reason?: string }> {
  const token = position.token as `0x${string}`;
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) return { checked: false, exited: false };
  const balance = await tokenBalance(client, token, walletAddress(env.WALLET_PRIVATE_KEY) as `0x${string}`);
  if (balance <= 0n) {
    return { checked: false, exited: false, reason: "wallet token balance is zero; reconciliation required" };
  }

  const quote = await quoteSell(client, token, balance);
  if (quote <= 0n) return { checked: true, exited: false, reason: "sell quote unavailable" };
  const proceedsMon = Number(quote) / 1e18;
  const quantity = Number(balance) / 1e18;
  const priceUsd = quantity > 0 && monUsd > 0 ? proceedsMon * monUsd / quantity : 0;
  if (!(priceUsd > 0)) return { checked: true, exited: false, reason: "effective exit price unavailable" };

  const history = await readHotHistory(env, token.toLowerCase());
  const pattern = buildPatternProfile(history);
  const pnlPct = position.entryPriceUsd > 0 ? ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100 : 0;
  const highWater = Math.max(position.highWaterPriceUsd || 0, priceUsd);
  const updatedPosition: LivePositionMirror = {
    ...position,
    quantity: balance.toString(),
    highWaterPriceUsd: highWater,
    lastPriceUsd: priceUsd,
    lastCheckedTsMs: Date.now()
  };

  const hardStopPct = envNumber(env.LIVE_HARD_STOP_PCT, DEFAULT_HARD_STOP_PCT);
  const rapidCrashPct = envNumber(env.LIVE_RAPID_CRASH_PCT, DEFAULT_RAPID_CRASH_PCT);
  const takeProfitPct = envNumber(env.LIVE_TAKE_PROFIT_PCT, DEFAULT_TAKE_PROFIT_PCT);
  const trailingActivationPct = envNumber(env.LIVE_TRAILING_ACTIVATION_PCT, DEFAULT_TRAILING_ACTIVATION_PCT);
  const trailingDrawdownPct = envNumber(env.LIVE_TRAILING_DRAWDOWN_PCT, DEFAULT_TRAILING_DRAWDOWN_PCT);
  const highZoneProfitPct = envNumber(env.LIVE_HIGH_ZONE_PROFIT_PCT, DEFAULT_HIGH_ZONE_PROFIT_PCT);

  const hardStop = pnlPct <= hardStopPct;
  const rapidCrash = position.lastPriceUsd > 0 && position.lastCheckedTsMs > 0 && Date.now() - position.lastCheckedTsMs <= DEFAULT_RAPID_CRASH_WINDOW_MS && priceUsd <= position.lastPriceUsd * (1 + rapidCrashPct / 100);
  const highLevel = pattern.priceBehavior.avgHighPrice12h > 0 ? pattern.priceBehavior.avgHighPrice12h : pattern.priceBehavior.avgHighPrice24h;
  const historicalHigh = highLevel > 0 && priceUsd >= highLevel * 0.95;
  const takeProfit = pnlPct >= takeProfitPct && (pattern.priceBehavior.currentZone === "HIGH" || historicalHigh || pattern.regimeHint === "DISTRIBUTION");
  const trailing = pnlPct >= trailingActivationPct && highWater > 0 && ((priceUsd - highWater) / highWater) * 100 <= -Math.abs(trailingDrawdownPct);
  const highZoneExit = pnlPct >= highZoneProfitPct && pattern.priceBehavior.currentZone === "HIGH" && pattern.priceBehavior.currentMinutesInZone >= Math.max(5, pattern.priceBehavior.avgMinutesNearHigh12h * 0.75);

  const reason = hardStop
    ? `hard stop ${pnlPct.toFixed(2)}%`
    : rapidCrash
      ? `rapid crash ${(((priceUsd / position.lastPriceUsd) - 1) * 100).toFixed(2)}%`
      : takeProfit
        ? `take profit ${pnlPct.toFixed(2)}%`
        : trailing
          ? `trailing profit protection ${(((priceUsd / highWater) - 1) * 100).toFixed(2)}% from high-water`
          : highZoneExit
            ? `historical high-zone profit exit ${pnlPct.toFixed(2)}%`
            : null;

  const positions = await readPositions(env);
  const index = positions.findIndex(item => item.token.toLowerCase() === token.toLowerCase());
  if (index >= 0) {
    positions[index] = updatedPosition;
    await writePositions(env, positions);
  }

  if (!reason) return { checked: true, exited: false };
  const exited = await emergencySell(env, updatedPosition, priceUsd, reason, monUsd, balance, quote);
  return { checked: true, exited, reason };
}

export async function runLivePositionGuard(env: GuardEnv): Promise<void> {
  if (env.TRADING_ENABLED !== "true" || env.PAPER_TRADING === "true" || !env.WALLET_PRIVATE_KEY) return;
  const positions = await readPositions(env);
  if (!positions.length) return;
  const monUsd = await readMonUsd(env);
  if (!(monUsd > 0)) {
    await notifyTelegram(env, "🛑 CIEL LIVE POSITION GUARD\nMON/USD unavailable; live exit guard is waiting for a valid MON price.");
    return;
  }

  const address = walletAddress(env.WALLET_PRIVATE_KEY);
  if (!address) return;
  const client = publicClient(env.NAD_RPC_URL);
  let checked = 0;
  let exited = 0;
  let warning: string | null = null;

  for (const position of positions.slice(0, MAX_GUARD_POSITIONS)) {
    try {
      const result = await monitorOnePosition(env, position, client, monUsd);
      if (result.checked) checked++;
      if (result.exited) exited++;
      if (result.reason && !result.exited) warning = `${position.token}: ${result.reason}`;
    } catch (error) {
      warning = `${position.token}: ${String(error).slice(0, 400)}`;
    }
  }

  if (warning) {
    await notifyTelegram(env, `⚠️ CIEL LIVE POSITION GUARD\nChecked: ${checked}\nEmergency exits: ${exited}\nWarning: ${warning}`);
  }
}

export async function flushEmergencyExitQueue(env: GuardEnv): Promise<void> {
  const raw = await env.CIEL_STATE.get(EMERGENCY_QUEUE_KEY);
  if (!raw) return;
  let queue: Array<Record<string, unknown>> = [];
  try { queue = JSON.parse(raw) as Array<Record<string, unknown>>; } catch { return; }
  if (!Array.isArray(queue) || !queue.length) return;

  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS live_positions (token_address TEXT PRIMARY KEY, quantity TEXT NOT NULL, entry_price_usd REAL, entry_ts_ms INTEGER, last_price_usd REAL, updated_ts_ms INTEGER NOT NULL)`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, token_address TEXT NOT NULL, ts_ms INTEGER NOT NULL, side TEXT NOT NULL, quantity TEXT, price_usd REAL, tx_hash TEXT, mode TEXT, status TEXT, execution_key TEXT)`).run();

    const remaining: Array<Record<string, unknown>> = [];
    for (const event of queue) {
      const token = String(event.token || "");
      const txHash = String(event.txHash || "");
      if (!/^0x[a-fA-F0-9]{40}$/.test(token) || !txHash) continue;
      try {
        await env.DB.prepare(`INSERT INTO trades(token_address, ts_ms, side, quantity, price_usd, tx_hash, mode, status, execution_key) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
          token,
          num(event.tsMs, Date.now()),
          "SELL",
          String(event.quantity || "0"),
          num(event.exitPriceUsd),
          txHash,
          "live",
          "CONFIRMED",
          `emergency:${txHash}`
        ).run();
        await env.DB.prepare(`DELETE FROM live_positions WHERE token_address=?`).bind(token).run();
        await env.CIEL_STATE.delete(`${EMERGENCY_MARKER_PREFIX}${token.toLowerCase()}`);
      } catch {
        remaining.push(event);
      }
    }

    if (remaining.length) await env.CIEL_STATE.put(EMERGENCY_QUEUE_KEY, JSON.stringify(remaining), { expirationTtl: 604800 });
    else await env.CIEL_STATE.delete(EMERGENCY_QUEUE_KEY);
  } catch (error) {
    console.error(`Emergency exit D1 reconciliation failed: ${String(error).slice(0, 1000)}`);
  }
}
