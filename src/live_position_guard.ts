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
const HOT_STATE_KEY = "ciel_hot_intelligence_state";
const MARKET_STATE_KEY = "ciel_market_state";
const RUNTIME_KEY = "ciel_runtime_state";
const EMERGENCY_QUEUE_KEY = "ciel_emergency_exit_queue";
const EMERGENCY_MARKER_PREFIX = "ciel_emergency_exit:";
const EXIT_LOCK_PREFIX = "ciel_live_exit_lock:";
const EXIT_LOCK_TTL_SECONDS = 180;
const EMERGENCY_MARKER_TTL_SECONDS = 86400;
const DEFAULT_HARD_STOP_PCT = -20;
const DEFAULT_RAPID_CRASH_PCT = -10;
const RAPID_CRASH_WINDOW_MS = 3 * 60 * 1000;
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

interface HotMarketState {
  symbol?: string;
  snapshots?: Snapshot[];
}

interface HotState {
  markets?: Record<string, HotMarketState>;
}

interface MarketState {
  monUsd?: number;
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

async function readPositions(env: GuardEnv): Promise<LivePositionMirror[]> {
  const raw = await env.CIEL_STATE.get(LIVE_POSITIONS_HOT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item === "object")
      .map(item => item as LivePositionMirror)
      .filter(item => /^0x[a-fA-F0-9]{40}$/.test(String(item.token || "")))
      .slice(0, MAX_GUARD_POSITIONS);
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

export async function upsertLivePositionMirror(
  env: GuardEnv,
  position: Omit<LivePositionMirror, "highWaterPriceUsd" | "lastPriceUsd" | "lastCheckedTsMs">
): Promise<void> {
  const positions = await readPositions(env);
  const key = position.token.toLowerCase();
  const index = positions.findIndex(item => item.token.toLowerCase() === key);
  const existing = index >= 0 ? positions[index] : undefined;
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

async function readHotState(env: GuardEnv): Promise<HotState> {
  const raw = await env.CIEL_STATE.get(HOT_STATE_KEY);
  if (!raw) return { markets: {} };
  try {
    const state = JSON.parse(raw) as HotState;
    return state && state.markets ? state : { markets: {} };
  } catch {
    return { markets: {} };
  }
}

async function readMonUsd(env: GuardEnv): Promise<number> {
  const marketRaw = await env.CIEL_STATE.get(MARKET_STATE_KEY);
  if (marketRaw) {
    try {
      const market = JSON.parse(marketRaw) as MarketState;
      const value = num(market.monUsd);
      if (value > 0) return value;
    } catch {}
  }

  const runtimeRaw = await env.CIEL_STATE.get(RUNTIME_KEY);
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
  await env.CIEL_STATE.put(EMERGENCY_QUEUE_KEY, JSON.stringify(queue.slice(-20)), { expirationTtl: 604800 });
}

function exitReason(
  env: GuardEnv,
  position: LivePositionMirror,
  currentPriceUsd: number,
  pnlPct: number,
  pattern: ReturnType<typeof buildPatternProfile>
): string | null {
  const hardStopPct = num(env.LIVE_HARD_STOP_PCT, DEFAULT_HARD_STOP_PCT);
  if (pnlPct <= hardStopPct) return `hard stop ${pnlPct.toFixed(2)}%`;

  const rapidCrashPct = num(env.LIVE_RAPID_CRASH_PCT, DEFAULT_RAPID_CRASH_PCT);
  const elapsed = Date.now() - position.lastCheckedTsMs;
  if (
    position.lastPriceUsd > 0 &&
    position.lastCheckedTsMs > 0 &&
    elapsed >= 0 &&
    elapsed <= RAPID_CRASH_WINDOW_MS &&
    currentPriceUsd <= position.lastPriceUsd * (1 + rapidCrashPct / 100)
  ) {
    return `rapid crash ${(((currentPriceUsd / position.lastPriceUsd) - 1) * 100).toFixed(2)}%`;
  }

  const behavior = pattern.priceBehavior;
  const highLevel = behavior.avgHighPrice12h > 0 ? behavior.avgHighPrice12h : behavior.avgHighPrice24h;
  const historicalHigh = highLevel > 0 && currentPriceUsd >= highLevel * 0.95;
  const highZone = behavior.currentZone === "HIGH";
  const takeProfitPct = num(env.LIVE_TAKE_PROFIT_PCT, DEFAULT_TAKE_PROFIT_PCT);
  if (pnlPct >= takeProfitPct && (highZone || historicalHigh || pattern.regimeHint === "DISTRIBUTION")) {
    return `take profit ${pnlPct.toFixed(2)}%`;
  }

  const trailingActivationPct = num(env.LIVE_TRAILING_ACTIVATION_PCT, DEFAULT_TRAILING_ACTIVATION_PCT);
  const trailingDrawdownPct = num(env.LIVE_TRAILING_DRAWDOWN_PCT, DEFAULT_TRAILING_DRAWDOWN_PCT);
  if (
    pnlPct >= trailingActivationPct &&
    position.highWaterPriceUsd > 0 &&
    ((currentPriceUsd - position.highWaterPriceUsd) / position.highWaterPriceUsd) * 100 <= -Math.abs(trailingDrawdownPct)
  ) {
    return `trailing profit protection ${(((currentPriceUsd / position.highWaterPriceUsd) - 1) * 100).toFixed(2)}% from high-water`;
  }

  const highZoneProfitPct = num(env.LIVE_HIGH_ZONE_PROFIT_PCT, DEFAULT_HIGH_ZONE_PROFIT_PCT);
  if (
    pnlPct >= highZoneProfitPct &&
    highZone &&
    behavior.currentMinutesInZone >= Math.max(5, behavior.avgMinutesNearHigh12h * 0.75)
  ) {
    return `historical high-zone profit exit ${pnlPct.toFixed(2)}%`;
  }

  return null;
}

async function emergencySell(
  env: GuardEnv,
  position: LivePositionMirror,
  priceUsd: number,
  pnlPct: number,
  reason: string,
  monUsd: number,
  balance: bigint,
  quote: bigint
): Promise<boolean> {
  if (!env.WALLET_PRIVATE_KEY) return false;
  const token = position.token.toLowerCase();
  const lockKey = `${EXIT_LOCK_PREFIX}${token}`;
  if (await env.CIEL_STATE.get(lockKey)) return false;

  await env.CIEL_STATE.put(lockKey, String(Date.now()), { expirationTtl: EXIT_LOCK_TTL_SECONDS });
  await env.CIEL_STATE.put(`${EMERGENCY_MARKER_PREFIX}${token}`, reason, { expirationTtl: EMERGENCY_MARKER_TTL_SECONDS });

  try {
    const client = publicClient(env.NAD_RPC_URL);
    const slippageBps = num(env.LIVE_EMERGENCY_SLIPPAGE_BPS, DEFAULT_EMERGENCY_SLIPPAGE_BPS);
    const txHash = await sellToNative({
      rpcUrl: env.NAD_RPC_URL,
      privateKey: env.WALLET_PRIVATE_KEY,
      token: position.token as `0x${string}`,
      amountIn: balance,
      amountOutMin: minimumOut(quote, slippageBps),
      deadlineSeconds: 30
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`emergency SELL reverted: ${txHash}`);

    const proceedsMon = Number(quote) / 1e18;
    const quantity = Number(balance) / 1e18;
    const exitPriceUsd = quantity > 0 && monUsd > 0 ? proceedsMon * monUsd / quantity : priceUsd;
    const now = Date.now();

    await enqueueEmergencyExit(env, {
      token: position.token,
      quantity: balance.toString(),
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd,
      txHash,
      tsMs: now,
      reason,
      pnlPct,
      status: "PENDING_D1_RECONCILIATION"
    });

    await notifyTelegram(env, `🚨 CIEL LIVE SELL\nToken: ${position.token}\nPnL: ${pnlPct.toFixed(2)}%\nReason: ${reason}\nTX: ${txHash}\nD1 reconciliation: queued`);
    return true;
  } catch (error) {
    await notifyTelegram(env, `🛑 CIEL LIVE SELL FAILED\nToken: ${position.token}\nReason: ${reason}\nError: ${String(error).slice(0, 700)}`);
    return false;
  } finally {
    await env.CIEL_STATE.delete(lockKey);
  }
}

export async function runLivePositionGuard(env: GuardEnv): Promise<void> {
  if (env.TRADING_ENABLED !== "true" || env.PAPER_TRADING === "true" || !env.WALLET_PRIVATE_KEY) return;

  const positions = await readPositions(env);
  if (!positions.length) return;

  const monUsd = await readMonUsd(env);
  if (!(monUsd > 0)) return;
  const address = walletAddress(env.WALLET_PRIVATE_KEY);
  if (!address) return;

  const client = publicClient(env.NAD_RPC_URL);
  const hotState = await readHotState(env);
  let changed = false;
  let checked = 0;
  let exited = 0;
  const warnings: string[] = [];
  const remaining: LivePositionMirror[] = [];

  for (const original of positions) {
    const token = original.token as `0x${string}`;
    try {
      const balance = await tokenBalance(client, token, address);
      if (balance <= 0n) {
        warnings.push(`${original.token}: wallet balance is zero; reconciliation required`);
        remaining.push(original);
        continue;
      }

      const quote = await quoteSell(client, token, balance);
      if (quote <= 0n) {
        warnings.push(`${original.token}: sell quote unavailable`);
        remaining.push(original);
        continue;
      }

      const quantity = Number(balance) / 1e18;
      const proceedsMon = Number(quote) / 1e18;
      const priceUsd = quantity > 0 ? proceedsMon * monUsd / quantity : 0;
      if (!(priceUsd > 0)) {
        warnings.push(`${original.token}: effective exit price unavailable`);
        remaining.push(original);
        continue;
      }

      checked++;
      const key = original.token.toLowerCase();
      const history = hotState.markets?.[key]?.snapshots || [];
      const pattern = buildPatternProfile(history);
      const pnlPct = original.entryPriceUsd > 0 ? ((priceUsd - original.entryPriceUsd) / original.entryPriceUsd) * 100 : 0;
      const highWater = Math.max(original.highWaterPriceUsd || 0, priceUsd);
      const updated: LivePositionMirror = {
        ...original,
        quantity: balance.toString(),
        highWaterPriceUsd: highWater,
        lastPriceUsd: priceUsd,
        lastCheckedTsMs: Date.now()
      };

      const reason = exitReason(env, original, priceUsd, pnlPct, pattern);
      if (reason) {
        const didExit = await emergencySell(env, updated, priceUsd, pnlPct, reason, monUsd, balance, quote);
        if (didExit) {
          exited++;
          changed = true;
          continue;
        }
      }

      if (
        updated.quantity !== original.quantity ||
        updated.highWaterPriceUsd !== original.highWaterPriceUsd ||
        Math.abs(updated.lastPriceUsd - original.lastPriceUsd) > 0
      ) changed = true;
      remaining.push(updated);
    } catch (error) {
      warnings.push(`${original.token}: ${String(error).slice(0, 500)}`);
      remaining.push(original);
    }
  }

  if (changed) await writePositions(env, remaining);

  if (checked || exited || warnings.length) {
    const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
    let runtime: Record<string, unknown> = {};
    try { runtime = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}
    await env.CIEL_STATE.put(
      RUNTIME_KEY,
      JSON.stringify({
        ...runtime,
        lastLivePositionGuard: Date.now(),
        lastLivePositionGuardChecked: checked,
        lastLivePositionGuardExited: exited,
        lastLivePositionGuardWarning: warnings[0] || null
      }),
      { expirationTtl: 172800 }
    );
  }
}

export async function flushEmergencyExitQueue(env: GuardEnv): Promise<void> {
  const raw = await env.CIEL_STATE.get(EMERGENCY_QUEUE_KEY);
  if (!raw) return;
  let queue: Array<Record<string, unknown>>;
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

    if (remaining.length) await env.CIEL_STATE.put(EMERGENCY_QUEUE_KEY, JSON.stringify(remaining.slice(-20)), { expirationTtl: 604800 });
    else await env.CIEL_STATE.delete(EMERGENCY_QUEUE_KEY);
  } catch (error) {
    console.error(`Emergency exit D1 reconciliation failed: ${String(error).slice(0, 1000)}`);
  }
}
