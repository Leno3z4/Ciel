import worker, { TradingEngine } from "./worker";
import { handleTelegramWebhook } from "./telegram_chat";
import { getMarketState } from "./market_discovery";
import { runLiveSignalCycle } from "./live_execution";

export { TradingEngine };

const D1_DEGRADED_KEY = "ciel_d1_degraded_utc_date";
const D1_ERROR_KEY = "ciel_d1_degraded_error";
const D1_QUOTA_ERROR = /D1_ERROR|daily row read limit|free tier.*row read|exceeded D1.*free tier/i;
const HISTORICAL_ERROR_MAX_AGE_MS = 30 * 60 * 1000;
const BOOTSTRAP_BUY_KEY = "ciel_bootstrap_buy_v1";
const BOOTSTRAP_ATTEMPT_KEY = "ciel_bootstrap_buy_attempt_ms";
const BOOTSTRAP_MAX_FEED_AGE_MS = 3 * 60 * 1000;
const BOOTSTRAP_MIN_MARKET_CAP_USD = 50_000;
const BOOTSTRAP_MIN_LIQUIDITY_USD = 5_000;

function utcDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function refreshD1Health(env: Parameters<typeof worker.fetch>[1]): Promise<{
  available: boolean;
  quotaExceeded: boolean;
  error: string | null;
  checkedAt: number;
}> {
  const checkedAt = Date.now();
  try {
    await env.DB.prepare("SELECT 1 as ok").first<{ ok: number }>();
    await env.CIEL_STATE.delete(D1_DEGRADED_KEY);
    await env.CIEL_STATE.delete(D1_ERROR_KEY);
    return { available: true, quotaExceeded: false, error: null, checkedAt };
  } catch (error) {
    const message = String(error).slice(0, 1000);
    const quotaExceeded = D1_QUOTA_ERROR.test(message);
    if (quotaExceeded) {
      await env.CIEL_STATE.put(D1_DEGRADED_KEY, utcDateKey(checkedAt), { expirationTtl: 172800 });
      await env.CIEL_STATE.put(D1_ERROR_KEY, message, { expirationTtl: 172800 });
    }
    return { available: false, quotaExceeded, error: message, checkedAt };
  }
}

function sanitizeStatus(payload: Record<string, unknown>, d1: Awaited<ReturnType<typeof refreshD1Health>>): Record<string, unknown> {
  const now = Date.now();
  const sanitized = { ...payload };

  const legacyGeminiAttempt = Number(sanitized.lastGeminiAttempt || 0);
  const legacyGeminiError = typeof sanitized.lastGeminiError === "string" ? sanitized.lastGeminiError : null;
  if (legacyGeminiError && legacyGeminiAttempt > 0) {
    const ageMs = Math.max(0, now - legacyGeminiAttempt);
    sanitized.lastGeminiErrorAgeSeconds = Math.floor(ageMs / 1000);
    sanitized.lastGeminiErrorIsHistorical = ageMs > HISTORICAL_ERROR_MAX_AGE_MS;
    if (ageMs > HISTORICAL_ERROR_MAX_AGE_MS) {
      sanitized.lastGeminiHistoricalError = legacyGeminiError;
      sanitized.lastGeminiError = null;
    }
  }

  const lastMarketCycle = Number(sanitized.lastMarketCycle || 0);
  const lastMarketCycleError = typeof sanitized.lastMarketCycleError === "string" ? sanitized.lastMarketCycleError : null;
  if (lastMarketCycleError && lastMarketCycle > 0 && now - lastMarketCycle > HISTORICAL_ERROR_MAX_AGE_MS) {
    sanitized.lastMarketCycleErrorHistorical = lastMarketCycleError;
    sanitized.lastMarketCycleError = null;
  }

  const lastHoldingCheck = Number(sanitized.lastHoldingCheck || 0);
  const lastHoldingCheckError = typeof sanitized.lastHoldingCheckError === "string" ? sanitized.lastHoldingCheckError : null;
  if (lastHoldingCheckError && lastHoldingCheck > 0 && now - lastHoldingCheck > HISTORICAL_ERROR_MAX_AGE_MS) {
    sanitized.lastHoldingCheckErrorHistorical = lastHoldingCheckError;
    sanitized.lastHoldingCheckError = null;
  }

  sanitized.d1Degraded = !d1.available;
  sanitized.d1DegradedError = d1.available ? null : d1.error;
  sanitized.d1Live = {
    available: d1.available,
    quotaExceeded: d1.quotaExceeded,
    checkedAt: d1.checkedAt,
    error: d1.available ? null : d1.error
  };

  return sanitized;
}

function numberFromItem(item: Record<string, unknown>, keys: string[]): number {
  const sources = [item.market_info, item.token_info, item];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const object = source as Record<string, unknown>;
    for (const key of keys) {
      const value = Number(object[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}

function tokenAddressFromItem(item: Record<string, unknown>): string | null {
  const sources = [item.token_info, item.market_info, item];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const object = source as Record<string, unknown>;
    for (const key of ["token_id", "token_address", "tokenAddress", "address", "mint", "id"]) {
      const value = object[key];
      if (typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim())) return value.trim().toLowerCase();
    }
  }
  return null;
}

async function enrichLiveStatus(
  env: Parameters<typeof worker.fetch>[1],
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const livePortfolio: Record<string, unknown> = {
    openPositionCount: 0,
    positions: [],
    lastLiveTrade: null,
    recentTrades: [],
    sellCanRealizeProfit: false
  };

  const lastTradeRaw = await env.CIEL_STATE.get("ciel_last_live_trade");
  if (lastTradeRaw) {
    try {
      livePortfolio.lastLiveTrade = JSON.parse(lastTradeRaw);
    } catch {}
  }

  try {
    const feed = await getMarketState(env);
    const prices = new Map<string, number>();
    for (const item of feed?.tokens || []) {
      const token = tokenAddressFromItem(item);
      const price = numberFromItem(item, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"]);
      if (token && price > 0) prices.set(token, price);
    }

    const positionRows = await env.DB
      .prepare(`
        SELECT
          token_address,
          quantity,
          entry_price_usd,
          entry_ts_ms,
          last_price_usd,
          updated_ts_ms
        FROM live_positions
        WHERE quantity <> '0'
        ORDER BY updated_ts_ms DESC
      `)
      .all<{
        token_address: string;
        quantity: string;
        entry_price_usd: number;
        entry_ts_ms: number;
        last_price_usd: number;
        updated_ts_ms: number;
      }>();

    const positions = (positionRows.results || []).map((position) => {
      const quantity = Number(position.quantity || 0);
      const entryPriceUsd = Number(position.entry_price_usd || 0);
      const currentPriceUsd =
        prices.get(position.token_address.toLowerCase()) ||
        Number(position.last_price_usd || 0);
      const marketValueUsd =
        currentPriceUsd > 0 ? quantity * currentPriceUsd : 0;
      const costUsd =
        entryPriceUsd > 0 ? quantity * entryPriceUsd : 0;
      const unrealizedPnlUsd =
        marketValueUsd > 0 && costUsd > 0
          ? marketValueUsd - costUsd
          : 0;
      const unrealizedPnlPct =
        costUsd > 0
          ? (unrealizedPnlUsd / costUsd) * 100
          : 0;

      return {
        token: position.token_address,
        quantity: position.quantity,
        entryPriceUsd,
        currentPriceUsd,
        costUsd,
        marketValueUsd,
        unrealizedPnlUsd,
        unrealizedPnlPct,
        entryTsMs: position.entry_ts_ms,
        updatedTsMs: position.updated_ts_ms
      };
    });

    livePortfolio.openPositionCount = positions.length;
    livePortfolio.positions = positions;
    livePortfolio.sellCanRealizeProfit = positions.some(position => Number(position.unrealizedPnlUsd) > 0);

    const recentTrades = await env.DB
      .prepare(`
        SELECT
          token_address,
          ts_ms,
          side,
          quantity,
          price_usd,
          tx_hash,
          status
        FROM trades
        WHERE mode='live'
          AND status='CONFIRMED'
          AND side IN ('BUY','SELL')
        ORDER BY ts_ms DESC
        LIMIT 10
      `)
      .all<{
        token_address: string;
        ts_ms: number;
        side: string;
        quantity: string | null;
        price_usd: number | null;
        tx_hash: string | null;
        status: string;
      }>();

    livePortfolio.recentTrades = recentTrades.results || [];
  } catch (error) {
    livePortfolio.diagnostics = `Live portfolio reporting unavailable: ${String(error).slice(0, 500)}`;
  }

  return {
    ...payload,
    livePortfolio
  };
}

async function maybeBootstrapBuy(env: Parameters<typeof worker.fetch>[1]): Promise<void> {
  if (env.TRADING_ENABLED !== "true") return;
  if (await env.CIEL_STATE.get(BOOTSTRAP_BUY_KEY) === "done") return;

  const lastAttempt = Number(await env.CIEL_STATE.get(BOOTSTRAP_ATTEMPT_KEY) || "0");
  if (lastAttempt > 0 && Date.now() - lastAttempt < 10 * 60 * 1000) return;

  const feed = await getMarketState(env);
  const feedAge = feed?.fetchedAt ? Date.now() - feed.fetchedAt : Number.POSITIVE_INFINITY;
  if (!feed || feedAge < 0 || feedAge > BOOTSTRAP_MAX_FEED_AGE_MS) return;

  await env.DB.prepare("CREATE TABLE IF NOT EXISTS live_positions (token_address TEXT PRIMARY KEY, quantity TEXT NOT NULL, entry_price_usd REAL, entry_ts_ms INTEGER, last_price_usd REAL, updated_ts_ms INTEGER NOT NULL)").run();
  const existingPosition = await env.DB.prepare("SELECT token_address FROM live_positions WHERE quantity<>'0' LIMIT 1").first<{ token_address: string }>();
  if (existingPosition) return;

  const hotRaw = await env.CIEL_STATE.get("ciel_hot_intelligence_state");
  let hot: Record<string, unknown> = {};
  try { hot = hotRaw ? JSON.parse(hotRaw) as Record<string, unknown> : {}; } catch {}
  const markets = hot.markets && typeof hot.markets === "object" ? hot.markets as Record<string, unknown> : {};

  const candidates = feed.ranked
    .map(row => {
      const token = row.token;
      const history = token && markets[token.toLowerCase()] && typeof markets[token.toLowerCase()] === "object"
        ? (markets[token.toLowerCase()] as Record<string, unknown>).snapshots
        : null;
      const snapshots = Array.isArray(history) ? history : [];
      const momentum = Number(row.percent || 0);
      const volume = Number(row.volume5mUsd || 0);
      const liquidity = Number(row.liquidityUsd || 0);
      const score = momentum * 4 + Math.log10(Math.max(1, volume)) + Math.min(5, liquidity / 10_000);
      return { row, snapshots, score };
    })
    .filter(candidate =>
      typeof candidate.row.token === "string" &&
      candidate.snapshots.length >= 8 &&
      candidate.row.marketCapUsd >= BOOTSTRAP_MIN_MARKET_CAP_USD &&
      candidate.row.liquidityUsd >= BOOTSTRAP_MIN_LIQUIDITY_USD &&
      candidate.row.volume5mUsd > 0 &&
      Number(candidate.row.percent || 0) > 0
    )
    .sort((a, b) => b.score - a.score);

  const candidate = candidates[0];
  if (!candidate?.row.token) return;

  const token = candidate.row.token;
  await env.CIEL_STATE.put(BOOTSTRAP_ATTEMPT_KEY, String(Date.now()), { expirationTtl: 3600 });

  const recent = await env.DB.prepare("SELECT id FROM signals WHERE token_address=? AND action='BUY' AND ts_ms>=? ORDER BY ts_ms DESC LIMIT 1").bind(token, Date.now() - 30 * 60 * 1000).first<{ id: number }>();
  if (recent) return;

  const now = Date.now();
  await env.DB.prepare(`INSERT INTO signals(token_address, ts_ms, action, confidence, expected_low, expected_high, anomaly_score, model, rationale) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    token,
    now,
    "BUY",
    0.65,
    0,
    0,
    0,
    "bootstrap-live",
    `Bootstrap entry after ${candidate.snapshots.length} live intelligence snapshots; ${candidate.row.percent.toFixed(2)}% current change, ${Math.round(candidate.row.liquidityUsd)} USD liquidity, and ${Math.round(candidate.row.volume5mUsd)} USD 5m volume.`
  ).run();

  await runLiveSignalCycle(env);

  const filled = await env.DB.prepare("SELECT token_address FROM live_positions WHERE token_address=? AND quantity<>'0'").bind(token).first<{ token_address: string }>();
  if (filled) {
    await env.CIEL_STATE.put(BOOTSTRAP_BUY_KEY, "done", { expirationTtl: 31536000 });
    await env.CIEL_STATE.put("ciel_runtime_state", JSON.stringify({
      ...(await (async () => {
        const raw = await env.CIEL_STATE.get("ciel_runtime_state");
        try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
      })()),
      lastModelAnalyzed: now,
      lastModelDecisionCandidate: token,
      lastModelDecisionAction: "BUY",
      lastModelDecisionConfidence: 0.65,
      lastModelError: undefined,
      kvModelActive: true,
      lastGeminiCycleStatus: "BOOTSTRAP_BUY_EXECUTED"
    }), { expirationTtl: 172800 });
  }
}

export default {
  async fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/status" && url.searchParams.get("telegramTest") !== "1") {
      const d1 = await refreshD1Health(env);
      const response = await worker.fetch(request, env);
      if (!response.ok) return response;
      try {
        const payload = await response.json() as Record<string, unknown>;
        const enriched = await enrichLiveStatus(env, payload);
        return new Response(JSON.stringify(sanitizeStatus(enriched, d1)), {
          status: response.status,
          headers: { "content-type": "application/json" }
        });
      } catch {
        return response;
      }
    }

    return worker.fetch(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Parameters<typeof worker.scheduled>[1],
    ctx: ExecutionContext
  ) {
    const result = await worker.scheduled(controller, env, ctx);
    if (controller.cron === "* * * * *") {
      try {
        await maybeBootstrapBuy(env);
      } catch (error) {
        console.error(`Bootstrap BUY failed: ${String(error).slice(0, 1000)}`);
      }
    }
    return result;
  }
};
