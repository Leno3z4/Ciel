import base, { type Env, TradingEngine } from "./index";
import { primeMarketDiscovery } from "./market_discovery";
import { notifyTelegram } from "./telegram";
import { runLiveSignalCycle } from "./live_execution";
import { runOptimizedHoldingCheck } from "./holding_monitor";
import { runKvIntelligenceCycle, flushPendingKvSignals } from "./kv_intelligence";
import { runLivePositionGuard, flushEmergencyExitQueue } from "./live_position_guard";

export { TradingEngine };

const HEARTBEAT_KEY = "ciel_telegram_heartbeat_ms";
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;
const SNAPSHOT_INDEX_KEY = "ciel_snapshot_query_index_v1";
const D1_DEGRADED_KEY = "ciel_d1_degraded_utc_date";
const D1_ERROR_KEY = "ciel_d1_degraded_error";
const D1_RECOVERY_PROBE_KEY = "ciel_d1_recovery_probe_utc_date";
const TELEGRAM_DECISION_ALERT_KEY = "ciel_telegram_last_decision_alert_ms";
const FEED_HEALTH_KEY = "ciel_market_feed_health";
const LIVE_MARKET_MAX_AGE_MS = 3 * 60 * 1000;

function utcDateKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isD1QuotaError(error: unknown): boolean {
  return /D1_ERROR|daily row read limit|free tier.*row read|exceeded D1.*free tier/i.test(String(error));
}

async function isD1Degraded(env: Env): Promise<boolean> {
  return (await env.CIEL_STATE.get(D1_DEGRADED_KEY)) === utcDateKey();
}

async function markD1Degraded(env: Env, error: unknown): Promise<void> {
  if (!isD1QuotaError(error)) return;
  const today = utcDateKey();
  await env.CIEL_STATE.put(D1_DEGRADED_KEY, today, { expirationTtl: 172800 });
  await env.CIEL_STATE.put(D1_ERROR_KEY, String(error).slice(0, 1000), { expirationTtl: 172800 });
}

async function clearD1Degraded(env: Env): Promise<void> {
  await env.CIEL_STATE.delete(D1_DEGRADED_KEY);
  await env.CIEL_STATE.delete(D1_ERROR_KEY);
}

async function recoverD1IfNewUtcDay(env: Env): Promise<boolean> {
  const today = utcDateKey();
  const lastProbeDate = await env.CIEL_STATE.get(D1_RECOVERY_PROBE_KEY);
  if (lastProbeDate === today) return !(await isD1Degraded(env));

  try {
    await env.DB.prepare("SELECT 1 as ok").first<{ ok: number }>();
    await clearD1Degraded(env);
    await env.CIEL_STATE.put(D1_RECOVERY_PROBE_KEY, today, { expirationTtl: 172800 });
    return true;
  } catch (error) {
    await env.CIEL_STATE.put(D1_RECOVERY_PROBE_KEY, today, { expirationTtl: 172800 });
    if (isD1QuotaError(error)) await markD1Degraded(env, error);
    return !(await isD1Degraded(env));
  }
}

async function ensureSnapshotQueryIndex(env: Env): Promise<boolean> {
  if (await isD1Degraded(env)) return false;
  if (await env.CIEL_STATE.get(SNAPSHOT_INDEX_KEY) === "1") return true;
  try {
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts_token ON market_snapshots(ts_ms, token_address, market_cap_usd)").run();
    await env.CIEL_STATE.put(SNAPSHOT_INDEX_KEY, "1", { expirationTtl: 31536000 });
    return true;
  } catch (error) {
    console.error(`Snapshot query index setup failed: ${String(error).slice(0, 500)}`);
    await markD1Degraded(env, error);
    return false;
  }
}

async function readFeedHealth(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(FEED_HEALTH_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function statusWithDiagnostics(request: Request, env: Env): Promise<Response> {
  await recoverD1IfNewUtcDay(env);
  const response = await base.fetch(request, env);
  const url = new URL(request.url);
  if (url.pathname !== "/status" || url.searchParams.get("telegramTest") === "1" || !response.ok) return response;
  try {
    const payload = await response.json() as Record<string, unknown>;
    const raw = await env.CIEL_STATE.get("ciel_runtime_state");
    let runtime: Record<string, unknown> = {};
    try { runtime = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}
    const diagnostics = [
      "lastIndexerDiscoveryCount", "lastIndexerValidAddressCount", "lastIndexerCandidateCount", "lastIndexerDirectEligible",
      "lastIndexerCapEligible", "lastIndexerChartAttempts", "lastIndexerChartHits", "lastIndexerSkipReason",
      "lastIndexerTopMarketCapUsd", "lastIndexerTopMarketCapSymbol", "lastModelEligibilityDiagnostics",
      "lastModelEligibilityWindowSamples", "lastModelDecisionBudgetPerCycle", "lastGeminiKeyUsed", "lastGeminiFallbacks",
      "lastGeminiApiAttemptAt", "lastGeminiApiSuccessAt", "lastGeminiApiFailureAt", "lastGeminiApiStatus",
      "lastGeminiApiError", "lastGeminiApiKeyUsed", "lastGeminiApiPoolUsed", "lastGeminiPoolAttempted",
      "lastGeminiCycleStartedAt", "lastGeminiCycleFinishedAt", "lastGeminiCycleStatus", "lastGeminiCycleToken",
      "lastGeminiCycleSnapshotAt", "lastGeminiLiveDataAt", "lastGeminiDecisionAt", "lastGeminiDecisionAction",
      "lastGeminiDecisionConfidence", "lastGeminiDecisionPool", "lastGeminiStatusUpdateAt",
      "lastModelDecisionCandidate", "lastModelDecisionAction", "lastModelDecisionConfidence", "lastHoldingPaperPositions",
      "lastHoldingLivePositions", "lastHoldingCheckError", "lastKvIntelligenceRun", "lastKvIntelligenceAnalyzed",
      "lastKvIntelligenceCandidates", "kvModelActive", "lastKvPendingFlush", "lastKvPendingQueued", "lastKvPendingDiscarded",
      "lastLivePositionGuard", "lastLivePositionGuardChecked", "lastLivePositionGuardExited", "lastLivePositionGuardWarning"
    ];
    for (const key of diagnostics) if (runtime[key] !== undefined) payload[key] = runtime[key];
    payload.lastIndexerSnapshotsThisCycle = Number(runtime.lastIndexerSnapshots || 0);
    payload.d1Degraded = await isD1Degraded(env);
    if (payload.d1Degraded) payload.d1DegradedError = await env.CIEL_STATE.get(D1_ERROR_KEY);
    const feedHealth = await readFeedHealth(env);
    const feedAgeSeconds = feedHealth.fetchedAt
      ? Math.max(0, Math.floor((Date.now() - Number(feedHealth.fetchedAt)) / 1000))
      : null;
    payload.kvMarketFeed = {
      ok: feedHealth.ok === true,
      source: feedHealth.source || null,
      fetchedAt: Number(feedHealth.fetchedAt || 0),
      ageSeconds: feedAgeSeconds,
      fresh: feedHealth.ok === true && feedAgeSeconds !== null && feedAgeSeconds <= LIVE_MARKET_MAX_AGE_MS / 1000,
      count: Number(feedHealth.count || 0),
      validCount: Number(feedHealth.validCount || 0),
      topMarketCapUsd: Number(feedHealth.topMarketCapUsd || 0),
      topSymbol: feedHealth.topSymbol || null,
      monUsd: Number(feedHealth.monUsd || 0) || null,
      diagnostics: feedHealth.diagnostics || null
    };
    const legacyGeminiAttempt = Number(runtime.lastGeminiAttempt || 0);
    if (runtime.lastGeminiError && legacyGeminiAttempt > 0) {
      payload.lastGeminiErrorAgeSeconds = Math.max(0, Math.floor((Date.now() - legacyGeminiAttempt) / 1000));
      payload.lastGeminiErrorIsHistorical = Date.now() - legacyGeminiAttempt > 30 * 60 * 1000;
    }
    payload.geminiLive = {
      cycleStatus: runtime.lastGeminiCycleStatus || null,
      lastApiStatus: runtime.lastGeminiApiStatus || null,
      lastApiAttemptAt: Number(runtime.lastGeminiApiAttemptAt || 0) || null,
      lastApiSuccessAt: Number(runtime.lastGeminiApiSuccessAt || 0) || null,
      lastApiFailureAt: Number(runtime.lastGeminiApiFailureAt || 0) || null,
      lastApiKeyUsed: Number(runtime.lastGeminiApiKeyUsed || 0) || null,
      lastApiPoolUsed: runtime.lastGeminiApiPoolUsed || null,
      lastError: runtime.lastGeminiApiError || null,
      liveDataAt: Number(runtime.lastGeminiLiveDataAt || 0) || null
    };
    payload.marketSnapshotTotalCount = null;
    payload.marketSnapshotHistory = [];
    payload.marketSnapshotDiagnostics = "D1 snapshot history is not queried from /status to avoid consuming the daily D1 row-read quota.";
    return new Response(JSON.stringify(payload), { status: response.status, headers: { "content-type": "application/json" } });
  } catch {
    return response;
  }
}

async function maybeSendDecisionAlert(env: Env): Promise<void> {
  const raw = await env.CIEL_STATE.get("ciel_runtime_state");
  if (!raw) return;
  let runtime: Record<string, unknown>;
  try { runtime = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  const action = String(runtime.lastModelDecisionAction || "").toUpperCase();
  if (action !== "BUY" && action !== "SELL") return;
  const decisionAt = Number(runtime.lastGeminiSuccess || runtime.lastModelAnalyzed || 0);
  if (!(decisionAt > 0)) return;
  const lastAlert = Number(await env.CIEL_STATE.get(TELEGRAM_DECISION_ALERT_KEY) || "0");
  if (decisionAt <= lastAlert) return;
  const candidate = typeof runtime.lastModelDecisionCandidate === "string" ? runtime.lastModelDecisionCandidate : "unknown";
  const confidence = Number(runtime.lastModelDecisionConfidence || 0);
  const mode = env.TRADING_ENABLED === "true" ? "LIVE" : "PAPER";
  await notifyTelegram(env, `${action === "BUY" ? "🟢" : "🔴"} CIEL ${action} DECISION\nToken: ${candidate}\nConfidence: ${(confidence * 100).toFixed(0)}%\nMode: ${mode}\nGemini analysis: ${new Date(decisionAt).toISOString()}`);
  await env.CIEL_STATE.put(TELEGRAM_DECISION_ALERT_KEY, String(decisionAt), { expirationTtl: 172800 });
}

async function maybeSendHeartbeat(env: Env): Promise<void> {
  const last = Number(await env.CIEL_STATE.get(HEARTBEAT_KEY) || "0");
  if (last > 0 && Date.now() - last < HEARTBEAT_INTERVAL_MS) return;
  await env.CIEL_STATE.put(HEARTBEAT_KEY, String(Date.now()), { expirationTtl: 3600 });
  const raw = await env.CIEL_STATE.get("ciel_runtime_state");
  let runtime: Record<string, unknown> = {};
  try { runtime = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}
  const feedHealth = await readFeedHealth(env);
  const discovered = Number(feedHealth.count || runtime.lastIndexerDiscoveryCount || 0);
  const valid = Number(feedHealth.validCount || runtime.lastIndexerValidAddressCount || 0);
  const candidates = Number(runtime.lastIndexerCandidateCount || 0);
  const capEligible = Number(runtime.lastIndexerCapEligible || 0);
  const snapshotsThisCycle = Number(runtime.lastIndexerSnapshots || 0);
  const topCap = Number(feedHealth.topMarketCapUsd || runtime.lastIndexerTopMarketCapUsd || 0);
  const topSymbol = typeof feedHealth.topSymbol === "string" ? feedHealth.topSymbol : typeof runtime.lastIndexerTopMarketCapSymbol === "string" ? runtime.lastIndexerTopMarketCapSymbol : "";
  const eligibility = runtime.lastModelEligibilityDiagnostics as Record<string, unknown> | undefined;
  const eligibilityLine = eligibility ? `\n\nModel eligibility\nMarkets: ${Number(eligibility.markets || 0)}\nHistory ≥8: ${Number(eligibility.historyEligible || 0)}\nSpan ≥15m: ${Number(eligibility.spanEligible || 0)}\nAvg volume ≥$1K: ${Number(eligibility.volumeEligible || 0)}\nAvg liquidity ≥$5K: ${Number(eligibility.liquidityEligible || 0)}\nEstablished: ${Number(eligibility.establishedEligible || 0)}` : "";
  const decisionLine = runtime.lastGeminiKeyUsed !== undefined || runtime.lastModelDecisionCandidate ? `\n\nDecision engine\nBudget/cycle: ${Number(runtime.lastModelDecisionBudgetPerCycle || 0)}\nCandidate: ${typeof runtime.lastModelDecisionCandidate === "string" ? runtime.lastModelDecisionCandidate.slice(0, 10) : "n/a"}\nGemini key slot: ${Number(runtime.lastGeminiKeyUsed || 0) || "n/a"}\nFallbacks used: ${Number(runtime.lastGeminiFallbacks || 0)}` : "";
  const kvModelLine = runtime.kvModelActive ? `\n\nKV intelligence\nCandidates: ${Number(runtime.lastKvIntelligenceCandidates || 0)}\nAnalyzed: ${Number(runtime.lastKvIntelligenceAnalyzed || 0)}\nActive: yes` : "";
  const recoveryLine = runtime.lastKvPendingFlush ? `\n\nKV signal recovery\nLast flush: ${new Date(Number(runtime.lastKvPendingFlush)).toISOString()}\nQueued: ${Number(runtime.lastKvPendingQueued || 0)}\nDiscarded: ${Number(runtime.lastKvPendingDiscarded || 0)}` : "";
  const guardLine = runtime.lastLivePositionGuard ? `\n\nLIVE position guard\nLast run: ${new Date(Number(runtime.lastLivePositionGuard)).toISOString()}\nChecked: ${Number(runtime.lastLivePositionGuardChecked || 0)}\nEmergency exits: ${Number(runtime.lastLivePositionGuardExited || 0)}${runtime.lastLivePositionGuardWarning ? `\nWarning: ${String(runtime.lastLivePositionGuardWarning).slice(0, 400)}` : ""}` : "";
  const capText = topCap > 0 ? `$${topCap >= 1_000_000 ? (topCap / 1_000_000).toFixed(2) + "M" : (topCap / 1_000).toFixed(1) + "K"}` : "n/a";
  const feedAge = feedHealth.fetchedAt ? Math.max(0, Math.floor((Date.now() - Number(feedHealth.fetchedAt)) / 1000)) : null;
  const kvLine = feedHealth.ok === true ? `\n\nKV market feed\nSource: ${String(feedHealth.source || "unknown")}\nMarkets: ${discovered}\nValid: ${valid}\nAge: ${feedAge === null ? "n/a" : `${feedAge}s`}\nTop cap: ${capText}${topSymbol ? ` (${topSymbol})` : ""}` : "\n\n⚠️ KV market feed has no healthy cache yet.";
  const d1Degraded = await isD1Degraded(env);
  const d1Line = d1Degraded ? "\n\n⚠️ D1 daily row-read limit reached. D1-dependent cycles are paused until the UTC reset; KV discovery + intelligence remain active." : "";
  await notifyTelegram(env, `📊 Ciel market monitor heartbeat\nDiscovered: ${discovered}\nValid: ${valid}\nCandidates: ${candidates}\n≥$50K market cap: ${capEligible}\nSnapshots this cycle: ${snapshotsThisCycle}\nTotal stored snapshots: ${d1Degraded ? "paused" : "not queried in heartbeat"}${kvLine}${kvModelLine}${recoveryLine}${guardLine}${eligibilityLine}${decisionLine}${d1Line}\n\nCiel is monitoring NadFun markets; market cap is the primary signal.`);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return statusWithDiagnostics(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await recoverD1IfNewUtcDay(env);

    if (controller.cron === "* * * * *") {
      ctx.waitUntil((async () => {
        try { await runLivePositionGuard(env); }
        catch (error) { console.error(`Live position guard failed: ${String(error).slice(0, 1000)}`); }
      })());
      return;
    }

    if (controller.cron === "*/2 * * * *") {
      if (await isD1Degraded(env)) return;
      ctx.waitUntil((async () => {
        await runOptimizedHoldingCheck(env);
        const runtimeRaw = await env.CIEL_STATE.get("ciel_runtime_state");
        try {
          const runtime = runtimeRaw ? JSON.parse(runtimeRaw) as Record<string, unknown> : {};
          if (Number(runtime.lastHoldingCheck || 0) >= Date.now() - 120000 && isD1QuotaError(runtime.lastHoldingCheckError)) await markD1Degraded(env, runtime.lastHoldingCheckError);
        } catch {}
      })());
      return;
    }

    if (controller.cron === "*/3 * * * *") {
      ctx.waitUntil((async () => {
        try { await primeMarketDiscovery(env); } catch (error) { console.error(`Market discovery failed: ${String(error).slice(0, 500)}`); }
        const feedHealth = await readFeedHealth(env);
        const feedAgeMs = feedHealth.fetchedAt ? Date.now() - Number(feedHealth.fetchedAt) : Number.POSITIVE_INFINITY;
        const freshLiveFeed = feedHealth.ok === true && feedAgeMs >= 0 && feedAgeMs <= LIVE_MARKET_MAX_AGE_MS;
        if (!freshLiveFeed) {
          const now = Date.now();
          await env.CIEL_STATE.put("ciel_runtime_state", JSON.stringify({
            ...(await (async () => {
              const raw = await env.CIEL_STATE.get("ciel_runtime_state");
              try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
            })()),
            lastKvIntelligenceRun: now,
            kvModelActive: false,
            lastGeminiCycleStartedAt: now,
            lastGeminiCycleFinishedAt: now,
            lastGeminiCycleStatus: "STALE_LIVE_MARKET_DATA",
            lastGeminiLiveDataAt: Number(feedHealth.fetchedAt || 0) || null,
            lastGeminiError: undefined,
            lastGeminiApiError: undefined
          }), { expirationTtl: 172800 });
          console.error(`KV intelligence skipped because live market feed is stale: ageMs=${feedAgeMs}`);
          return;
        }
        try { await runKvIntelligenceCycle(env); } catch (error) { console.error(`KV intelligence cycle failed: ${String(error).slice(0, 1000)}`); }
        if (await isD1Degraded(env)) return;
        try { await flushPendingKvSignals(env); } catch (error) { console.error(`KV pending recovery failed: ${String(error).slice(0, 1000)}`); }
        if (await isD1Degraded(env)) return;
        try { await maybeSendDecisionAlert(env); } catch (error) { console.error(`Decision Telegram alert failed: ${String(error).slice(0, 800)}`); }
        try { await runLiveSignalCycle(env); } catch (error) { await markD1Degraded(env, error); console.error(`Live execution cycle failed: ${String(error).slice(0, 1000)}`); }
      })());
      return;
    }

    if (controller.cron === "*/10 * * * *") {
      ctx.waitUntil((async () => {
        if (!(await isD1Degraded(env))) await ensureSnapshotQueryIndex(env);
        try { await primeMarketDiscovery(env); } catch (error) { console.error(`Market discovery prime failed: ${String(error).slice(0, 500)}`); }
        if (!(await isD1Degraded(env))) {
          try { await flushEmergencyExitQueue(env); } catch (error) { console.error(`Emergency exit reconciliation failed: ${String(error).slice(0, 800)}`); }
        }
        try { await maybeSendHeartbeat(env); } catch (error) { console.error(`Heartbeat failed: ${String(error).slice(0, 500)}`); }
      })());
      return;
    }

    if (controller.cron === "*/30 * * * *") {
      ctx.waitUntil((async () => {
        if (!(await isD1Degraded(env))) {
          try { await flushEmergencyExitQueue(env); } catch (error) { console.error(`Emergency exit reconciliation failed: ${String(error).slice(0, 800)}`); }
        }
      })());
      return;
    }

    await base.scheduled(controller, env, ctx);
  }
};

export default worker;