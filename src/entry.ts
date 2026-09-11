import worker, { TradingEngine } from "./worker";
import { handleTelegramWebhook } from "./telegram_chat";

export { TradingEngine };

const D1_DEGRADED_KEY = "ciel_d1_degraded_utc_date";
const D1_ERROR_KEY = "ciel_d1_degraded_error";
const D1_QUOTA_ERROR = /D1_ERROR|daily row read limit|free tier.*row read|exceeded D1.*free tier/i;
const HISTORICAL_ERROR_MAX_AGE_MS = 30 * 60 * 1000;

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
        return new Response(JSON.stringify(sanitizeStatus(payload, d1)), {
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
    return worker.scheduled(controller, env, ctx);
  }
};
