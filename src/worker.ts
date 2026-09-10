import base, { type Env, TradingEngine } from "./index";
import { primeMarketDiscovery } from "./market_discovery";
import { triggerEstablishedModelAnalysis } from "./model_trigger";
import { notifyTelegram } from "./telegram";
import { runLiveSignalCycle } from "./live_execution";
import { runOptimizedHoldingCheck } from "./holding_monitor";

export { TradingEngine };

const HEARTBEAT_KEY = "ciel_telegram_heartbeat_ms";
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
const SNAPSHOT_INDEX_KEY = "ciel_snapshot_query_index_v1";
const D1_DEGRADED_KEY = "ciel_d1_degraded_utc_date";
const D1_ERROR_KEY = "ciel_d1_degraded_error";
const TELEGRAM_DECISION_ALERT_KEY = "ciel_telegram_last_decision_alert_ms";
const FEED_HEALTH_KEY = "ciel_market_feed_health";

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

  await env.CIEL_STATE.put(
    D1_DEGRADED_KEY,
    utcDateKey(),
    { expirationTtl: 172800 }
  );

  await env.CIEL_STATE.put(
    D1_ERROR_KEY,
    String(error).slice(0, 1000),
    { expirationTtl: 172800 }
  );
}

async function clearD1Degraded(env: Env): Promise<void> {
  await env.CIEL_STATE.delete(D1_DEGRADED_KEY);
  await env.CIEL_STATE.delete(D1_ERROR_KEY);
}

async function ensureSnapshotQueryIndex(env: Env): Promise<boolean> {
  if (await isD1Degraded(env)) return false;
  if (await env.CIEL_STATE.get(SNAPSHOT_INDEX_KEY) === "1") return true;

  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts_token ON market_snapshots(ts_ms, token_address, market_cap_usd)"
    ).run();

    await env.CIEL_STATE.put(
      SNAPSHOT_INDEX_KEY,
      "1",
      { expirationTtl: 31536000 }
    );

    return true;
  } catch (error) {
    console.error(
      `Snapshot query index setup failed: ${String(error).slice(0, 500)}`
    );
    await markD1Degraded(env, error);
    return false;
  }
}

async function snapshotDiagnostics(env: Env): Promise<{ total: number; markets: Array<{ token: string; symbol: string | null; samples: number; ageMinutes: number }> }> {
  if (await isD1Degraded(env)) {
    return { total: 0, markets: [] };
  }

  try {
    const total = await env.DB.prepare("SELECT COUNT(*) as count FROM market_snapshots").first<{ count: number }>();
    const rows = await env.DB.prepare(`SELECT s.token_address as token, t.symbol as symbol, COUNT(*) as samples, (MAX(s.ts_ms)-MIN(s.ts_ms))/60000.0 as ageMinutes
      FROM market_snapshots s LEFT JOIN tokens t ON lower(t.address)=lower(s.token_address)
      WHERE s.price_usd>0 GROUP BY s.token_address, t.symbol ORDER BY COUNT(*) DESC LIMIT 10`).all<{ token: string; symbol: string | null; samples: number; ageMinutes: number }>();
    await clearD1Degraded(env);
    return { total: Number(total?.count || 0), markets: rows.results || [] };
  } catch (error) {
    await markD1Degraded(env, error);
    return { total: 0, markets: [] };
  }
}

async function readFeedHealth(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(FEED_HEALTH_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function statusWithDiagnostics(request: Request, env: Env): Promise<Response> {
  const response = await base.fetch(request, env);
  const url = new URL(request.url);
  if (url.pathname !== "/status" || url.searchParams.get("telegramTest") === "1" || !response.ok) return response;

  try {
    const payload = await response.json() as Record<string, unknown>;
    const raw = await env.CIEL_STATE.get("ciel_runtime_state");
    let runtime: Record<string, unknown> = {};
    try { runtime = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}

    const diagnostics = [
      "lastIndexerDiscoveryCount",
      "lastIndexerValidAddressCount",
      "lastIndexerCandidateCount",
      "lastIndexerDirectEligible",
      "lastIndexerCapEligible",
      "lastIndexerChartAttempts",
      "lastIndexerChartHits",
      "lastIndexerSkipReason",
      "lastIndexerTopMarketCapUsd",
      "lastIndexerTopMarketCapSymbol",
      "lastModelEligibilityDiagnostics",
      "lastModelEligibilityWindowSamples",
      "lastModelDecisionBudgetPerCycle",
      "lastGeminiKeyUsed",
      "lastGeminiFallbacks",
      "lastModelDecisionCandidate",
      "lastModelDecisionAction",
      "lastModelDecisionConfidence",
      "lastHoldingPaperPositions",
      "lastHoldingLivePositions",
      "lastHoldingCheckError"
    ];

    for (const key of diagnostics) {
      if (runtime[key] !== undefined) payload[key] = runtime[key];
    }

    payload.lastIndexerSnapshotsThisCycle = Number(
      runtime.lastIndexerSnapshots || 0
    );

    payload.d1Degraded = await isD1Degraded(env);

    if (payload.d1Degraded) {
      payload.d1DegradedError = await env.CIEL_STATE.get(D1_ERROR_KEY);
    }

    const feedHealth = await readFeedHealth(env);
    payload.kvMarketFeed = {
      ok: feedHealth.ok === true,
      source: feedHealth.source || null,
      fetchedAt: Number(feedHealth.fetchedAt || 0),
      ageSeconds: feedHealth.fetchedAt
        ? Math.max(0, Math.floor((Date.now() - Number(feedHealth.fetchedAt)) / 1000))
        : null,
      count: Number(feedHealth.count || 0),
      validCount: Number(feedHealth.validCount || 0),
      topMarketCapUsd: Number(feedHealth.topMarketCapUsd || 0),
      topSymbol: feedHealth.topSymbol || null,
      monUsd: Number(feedHealth.monUsd || 0) || null
    };

    if (payload.d1Degraded) {
      payload.lastIndexerDiscoveryCount = Number(feedHealth.count || 0);
      payload.lastIndexerValidAddressCount = Number(feedHealth.validCount || 0);
      payload.lastIndexerTopMarketCapUsd = Number(feedHealth.topMarketCapUsd || 0);
      payload.lastIndexerTopMarketCapSymbol = feedHealth.topSymbol || null;
      payload.lastIndexerSkipReason = "d1-degraded-kv-discovery-active";
    }

    const snapshots = await snapshotDiagnostics(env);
    payload.marketSnapshotTotalCount = snapshots.total;
    payload.marketSnapshotHistory = snapshots.markets;

    return new Response(
      JSON.stringify(payload),
      {
        status: response.status,
        headers: { "content-type": "application/json" }
      }
    );
  } catch {
    return response;
  }
}

async function maybeSendDecisionAlert(env: Env): Promise<void> {
  const raw = await env.CIEL_STATE.get("ciel_runtime_state");
  if (!raw) return;

  let runtime: Record<string, unknown>;

  try {
    runtime = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const action = String(
    runtime.lastModelDecisionAction || ""
  ).toUpperCase();

  if (action !== "BUY" && action !== "SELL") return;

  const decisionAt = Number(
    runtime.lastGeminiSuccess ||
    runtime.lastModelAnalyzed ||
    0
  );

  if (!(decisionAt > 0)) return;

  const lastAlert = Number(
    await env.CIEL_STATE.get(
      TELEGRAM_DECISION_ALERT_KEY
    ) || "0"
  );

  if (decisionAt <= lastAlert) return;

  const candidate = typeof runtime.lastModelDecisionCandidate === "string"
    ? runtime.lastModelDecisionCandidate
    : "unknown";

  const confidence = Number(
    runtime.lastModelDecisionConfidence || 0
  );

  const mode = env.TRADING_ENABLED === "true"
    ? "LIVE"
    : "PAPER";

  await notifyTelegram(
    env,
    `${action === "BUY" ? "🟢" : "🔴"} CIEL ${action} DECISION\nToken: ${candidate}\nConfidence: ${(confidence * 100).toFixed(0)}%\nMode: ${mode}\nGemini analysis: ${new Date(decisionAt).toISOString()}`
  );

  await env.CIEL_STATE.put(
    TELEGRAM_DECISION_ALERT_KEY,
    String(decisionAt),
    { expirationTtl: 172800 }
  );
}

async function maybeSendHeartbeat(env: Env): Promise<void> {
  const last = Number(await env.CIEL_STATE.get(HEARTBEAT_KEY) || "0");
  if (last > 0 && Date.now() - last < HEARTBEAT_INTERVAL_MS) return;

  await env.CIEL_STATE.put(
    HEARTBEAT_KEY,
    String(Date.now()),
    { expirationTtl: 3600 }
  );

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
  const topSymbol = typeof feedHealth.topSymbol === "string"
    ? feedHealth.topSymbol
    : typeof runtime.lastIndexerTopMarketCapSymbol === "string"
      ? runtime.lastIndexerTopMarketCapSymbol
      : "";
  const eligibility = runtime.lastModelEligibilityDiagnostics as Record<string, unknown> | undefined;
  const eligibilityLine = eligibility
    ? `\n\nModel eligibility (latest 12 snapshots)\nMarkets: ${Number(eligibility.markets || 0)}\nHistory ≥12: ${Number(eligibility.historyEligible || 0)}\nSpan ≥30m: ${Number(eligibility.spanEligible || 0)}\nAvg volume ≥$5K: ${Number(eligibility.volumeEligible || 0)}\nAvg liquidity ≥$10K: ${Number(eligibility.liquidityEligible || 0)}\nEstablished: ${Number(eligibility.establishedEligible || 0)}`
    : "";
  const decisionLine = runtime.lastGeminiKeyUsed !== undefined || runtime.lastModelDecisionCandidate
    ? `\n\nDecision engine\nBudget/cycle: ${Number(runtime.lastModelDecisionBudgetPerCycle || 0)}\nCandidate: ${typeof runtime.lastModelDecisionCandidate === "string" ? runtime.lastModelDecisionCandidate.slice(0, 10) : "n/a"}\nGemini key slot: ${Number(runtime.lastGeminiKeyUsed || 0) || "n/a"}\nFallbacks used: ${Number(runtime.lastGeminiFallbacks || 0)}`
    : "";
  const capText = topCap > 0 ? `$${topCap >= 1_000_000 ? (topCap / 1_000_000).toFixed(2) + "M" : (topCap / 1_000).toFixed(1) + "K"}` : "n/a";
  const d1Degraded = await isD1Degraded(env);
  const snapshots = d1Degraded
    ? { total: 0, markets: [] as Array<{ token: string; symbol: string | null; samples: number; ageMinutes: number }> }
    : await snapshotDiagnostics(env);
  const topHistory = snapshots.markets.slice(0, 5).map((row, i) => {
    const label = row.symbol && row.symbol.trim() ? row.symbol.trim() : row.token.slice(0, 10);
    return `${i + 1}. ${label} — ${row.samples} snapshots / ${row.ageMinutes.toFixed(1)}m`;
  }).join("\n");
  const feedAge = feedHealth.fetchedAt
    ? Math.max(0, Math.floor((Date.now() - Number(feedHealth.fetchedAt)) / 1000))
    : null;
  const kvLine = feedHealth.ok === true
    ? `\n\nKV market feed\nSource: ${String(feedHealth.source || "unknown")}\nMarkets: ${discovered}\nValid: ${valid}\nAge: ${feedAge === null ? "n/a" : `${feedAge}s`}\nTop cap: ${capText}${topSymbol ? ` (${topSymbol})` : ""}`
    : "\n\n⚠️ KV market feed has no healthy cache yet.";
  const d1Line = d1Degraded
    ? "\n\n⚠️ D1 daily row-read limit reached. D1-dependent cycles are paused until the UTC reset; KV market discovery/health remains active."
    : "";

  await notifyTelegram(
    env,
    `📊 Ciel market monitor heartbeat\nDiscovered: ${discovered}\nValid markets: ${valid}\nCandidates: ${candidates}\n≥$90K market cap: ${capEligible}\nSnapshots this cycle: ${snapshotsThisCycle}\nTotal stored snapshots: ${d1Degraded ? "paused" : snapshots.total}${kvLine}${topHistory ? `\n\nSnapshot history\n${topHistory}` : ""}${eligibilityLine}${decisionLine}${d1Line}\n\nCiel is monitoring established NadFun markets; market cap is the primary signal.`
  );
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return statusWithDiagnostics(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    if (controller.cron === "*/2 * * * *") {
      if (await isD1Degraded(env)) return;

      const startedAt = Date.now();

      ctx.waitUntil((async () => {
        await runOptimizedHoldingCheck(env);

        const runtimeRaw = await env.CIEL_STATE.get(
          "ciel_runtime_state"
        );

        try {
          const runtime = runtimeRaw
            ? JSON.parse(runtimeRaw) as Record<string, unknown>
            : {};
          const lastCheck = Number(
            runtime.lastHoldingCheck || 0
          );
          const error = runtime.lastHoldingCheckError;

          if (
            lastCheck >= startedAt &&
            isD1QuotaError(error)
          ) {
            await markD1Degraded(env, error);
          }
        } catch {}
      })());

      return;
    }

    if (controller.cron === "*/3 * * * *") {
      ctx.waitUntil((async () => {
        if (await isD1Degraded(env)) {
          try {
            await primeMarketDiscovery(env);
          } catch (error) {
            console.error(
              `KV market discovery refresh failed: ${String(error).slice(0, 500)}`
            );
          }

          return;
        }

        const startedAt = Date.now();
        const indexReady = await ensureSnapshotQueryIndex(env);

        if (
          !indexReady ||
          await isD1Degraded(env)
        ) {
          try {
            await primeMarketDiscovery(env);
          } catch (error) {
            console.error(
              `KV market discovery refresh failed: ${String(error).slice(0, 500)}`
            );
          }

          return;
        }

        try {
          await base.scheduled(
            controller,
            env,
            ctx
          );
        } catch (error) {
          await markD1Degraded(env, error);
        }

        const runtimeRaw = await env.CIEL_STATE.get(
          "ciel_runtime_state"
        );

        try {
          const runtime = runtimeRaw
            ? JSON.parse(runtimeRaw) as Record<string, unknown>
            : {};
          const lastCycle = Number(
            runtime.lastMarketCycle || 0
          );
          const cycleError = runtime.lastMarketCycleError;

          if (
            lastCycle >= startedAt &&
            isD1QuotaError(cycleError)
          ) {
            await markD1Degraded(
              env,
              cycleError
            );
          }
        } catch {}

        if (await isD1Degraded(env)) {
          try {
            await primeMarketDiscovery(env);
          } catch (error) {
            console.error(
              `KV market discovery refresh failed: ${String(error).slice(0, 500)}`
            );
          }

          return;
        }

        try {
          await triggerEstablishedModelAnalysis(env);
        } catch (error) {
          await markD1Degraded(env, error);
          console.error(
            `Established model trigger failed: ${String(error).slice(0, 1000)}`
          );
        }

        if (await isD1Degraded(env)) return;

        try {
          await maybeSendDecisionAlert(env);
        } catch (error) {
          console.error(
            `Decision Telegram alert failed: ${String(error).slice(0, 800)}`
          );
        }

        try {
          await runLiveSignalCycle(env);
        } catch (error) {
          await markD1Degraded(env, error);
          console.error(
            `Live execution cycle failed: ${String(error).slice(0, 1000)}`
          );
        }
      })());

      return;
    }

    if (controller.cron === "*/10 * * * *") {
      ctx.waitUntil((async () => {
        if (!(await isD1Degraded(env))) {
          await ensureSnapshotQueryIndex(env);
        }

        try {
          await primeMarketDiscovery(env);
        } catch (error) {
          console.error(
            `Market discovery prime failed: ${String(error).slice(0, 500)}`
          );
        }

        try {
          if (!(await isD1Degraded(env))) {
            await base.scheduled(
              controller,
              env,
              ctx
            );
          }
        } finally {
          await maybeSendHeartbeat(env);
        }
      })());

      return;
    }

    if (controller.cron === "0 * * * *") {
      if (!(await isD1Degraded(env))) {
        await ensureSnapshotQueryIndex(env);
      }

      return;
    }

    await base.scheduled(
      controller,
      env,
      ctx
    );
  }
};

export default worker;
