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

async function ensureSnapshotQueryIndex(env: Env): Promise<void> {
  if (await env.CIEL_STATE.get(SNAPSHOT_INDEX_KEY) === "1") return;

  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_market_snapshots_ts_token ON market_snapshots(ts_ms, token_address, market_cap_usd)"
    ).run();

    await env.CIEL_STATE.put(
      SNAPSHOT_INDEX_KEY,
      "1",
      { expirationTtl: 31536000 }
    );
  } catch (error) {
    console.error(
      `Snapshot query index setup failed: ${String(error).slice(0, 500)}`
    );
  }
}

async function snapshotDiagnostics(env: Env): Promise<{ total: number; markets: Array<{ token: string; symbol: string | null; samples: number; ageMinutes: number }> }> {
  try {
    const total = await env.DB.prepare("SELECT COUNT(*) as count FROM market_snapshots").first<{ count: number }>();
    const rows = await env.DB.prepare(`SELECT s.token_address as token, t.symbol as symbol, COUNT(*) as samples, (MAX(s.ts_ms)-MIN(s.ts_ms))/60000.0 as ageMinutes
      FROM market_snapshots s LEFT JOIN tokens t ON lower(t.address)=lower(s.token_address)
      WHERE s.price_usd>0 GROUP BY s.token_address, t.symbol ORDER BY COUNT(*) DESC LIMIT 10`).all<{ token: string; symbol: string | null; samples: number; ageMinutes: number }>();
    return { total: Number(total?.count || 0), markets: rows.results || [] };
  } catch {
    return { total: 0, markets: [] };
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
    for (const key of diagnostics) if (runtime[key] !== undefined) payload[key] = runtime[key];
    payload.lastIndexerSnapshotsThisCycle = Number(runtime.lastIndexerSnapshots || 0);
    const snapshots = await snapshotDiagnostics(env);
    payload.marketSnapshotTotalCount = snapshots.total;
    payload.marketSnapshotHistory = snapshots.markets;
    return new Response(JSON.stringify(payload), { status: response.status, headers: { "content-type": "application/json" } });
  } catch {
    return response;
  }
}

async function maybeSendHeartbeat(env: Env): Promise<void> {
  const last = Number(await env.CIEL_STATE.get(HEARTBEAT_KEY) || "0");
  if (last > 0 && Date.now() - last < HEARTBEAT_INTERVAL_MS) return;
  await env.CIEL_STATE.put(HEARTBEAT_KEY, String(Date.now()), { expirationTtl: 3600 });
  const raw = await env.CIEL_STATE.get("ciel_runtime_state");
  let runtime: Record<string, unknown> = {};
  try { runtime = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {}
  const discovered = Number(runtime.lastIndexerDiscoveryCount || 0);
  const valid = Number(runtime.lastIndexerValidAddressCount || 0);
  const candidates = Number(runtime.lastIndexerCandidateCount || 0);
  const capEligible = Number(runtime.lastIndexerCapEligible || 0);
  const snapshotsThisCycle = Number(runtime.lastIndexerSnapshots || 0);
  const topCap = Number(runtime.lastIndexerTopMarketCapUsd || 0);
  const topSymbol = typeof runtime.lastIndexerTopMarketCapSymbol === "string" ? runtime.lastIndexerTopMarketCapSymbol : "";
  const eligibility = runtime.lastModelEligibilityDiagnostics as Record<string, unknown> | undefined;
  const eligibilityLine = eligibility
    ? `\n\nModel eligibility (latest 12 snapshots)\nMarkets: ${Number(eligibility.markets || 0)}\nHistory ≥12: ${Number(eligibility.historyEligible || 0)}\nSpan ≥30m: ${Number(eligibility.spanEligible || 0)}\nAvg volume ≥$5K: ${Number(eligibility.volumeEligible || 0)}\nAvg liquidity ≥$10K: ${Number(eligibility.liquidityEligible || 0)}\nEstablished: ${Number(eligibility.establishedEligible || 0)}`
    : "";
  const decisionLine = runtime.lastGeminiKeyUsed !== undefined || runtime.lastModelDecisionCandidate
    ? `\n\nDecision engine\nBudget/cycle: ${Number(runtime.lastModelDecisionBudgetPerCycle || 0)}\nCandidate: ${typeof runtime.lastModelDecisionCandidate === "string" ? runtime.lastModelDecisionCandidate.slice(0, 10) : "n/a"}\nGemini key slot: ${Number(runtime.lastGeminiKeyUsed || 0) || "n/a"}\nFallbacks used: ${Number(runtime.lastGeminiFallbacks || 0)}`
    : "";
  const capText = topCap > 0 ? `$${topCap >= 1_000_000 ? (topCap / 1_000_000).toFixed(2) + "M" : (topCap / 1_000).toFixed(1) + "K"}` : "n/a";
  const snapshots = await snapshotDiagnostics(env);
  const topHistory = snapshots.markets.slice(0, 5).map((row, i) => {
    const label = row.symbol && row.symbol.trim() ? row.symbol.trim() : row.token.slice(0, 10);
    return `${i + 1}. ${label} — ${row.samples} snapshots / ${row.ageMinutes.toFixed(1)}m`;
  }).join("\n");
  await notifyTelegram(env, `📊 Ciel market monitor heartbeat\nDiscovered: ${discovered}\nValid markets: ${valid}\nCandidates: ${candidates}\n≥$90K market cap: ${capEligible}\nSnapshots this cycle: ${snapshotsThisCycle}\nTotal stored snapshots: ${snapshots.total}\nTop market cap: ${capText}${topSymbol ? ` (${topSymbol})` : ""}${topHistory ? `\n\nSnapshot history\n${topHistory}` : ""}${eligibilityLine}${decisionLine}\n\nCiel is monitoring established NadFun markets; market cap is the primary signal.`);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return statusWithDiagnostics(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "*/2 * * * *") {
      ctx.waitUntil(runOptimizedHoldingCheck(env));
      return;
    }

    if (controller.cron === "*/3 * * * *") {
      ctx.waitUntil((async () => {
        await ensureSnapshotQueryIndex(env);
        await base.scheduled(controller, env, ctx);

        try {
          await triggerEstablishedModelAnalysis(env);
        } catch (error) {
          console.error(
            `Established model trigger failed: ${String(error).slice(0, 1000)}`
          );
        }

        try {
          await runLiveSignalCycle(env);
        } catch (error) {
          console.error(
            `Live execution cycle failed: ${String(error).slice(0, 1000)}`
          );
        }
      })());

      return;
    }

    if (controller.cron === "*/10 * * * *") {
      ctx.waitUntil((async () => {
        await ensureSnapshotQueryIndex(env);
        try { await primeMarketDiscovery(env); } catch (error) { console.error(`Market discovery prime failed: ${String(error).slice(0, 500)}`); }
        try { await base.scheduled(controller, env, ctx); } finally { await maybeSendHeartbeat(env); }
      })());
      return;
    }

    /*
     * The old hourly base.scheduled() path only ran the legacy model
     * maintenance query. The dedicated model_trigger pipeline already runs
     * every 3 minutes, so running the legacy hourly query was duplicate D1
     * work and could push the free-tier row-read budget unnecessarily.
     */
    if (controller.cron === "0 * * * *") {
      await ensureSnapshotQueryIndex(env);
      return;
    }

    await base.scheduled(controller, env, ctx);
  }
};

export default worker;
