import base, { type Env, TradingEngine } from "./index";
import { primeMarketDiscovery } from "./market_discovery";
import { triggerEstablishedModelAnalysis } from "./model_trigger";
import { notifyTelegram } from "./telegram";

export { TradingEngine };

const HEARTBEAT_KEY = "ciel_telegram_heartbeat_ms";
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

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
      "lastIndexerTopMarketCapSymbol"
    ];
    for (const key of diagnostics) if (runtime[key] !== undefined) payload[key] = runtime[key];
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
  const snapshots = Number(runtime.lastIndexerSnapshots || 0);
  const topCap = Number(runtime.lastIndexerTopMarketCapUsd || 0);
  const topSymbol = typeof runtime.lastIndexerTopMarketCapSymbol === "string" ? runtime.lastIndexerTopMarketCapSymbol : "";
  const capText = topCap > 0 ? `$${topCap >= 1_000_000 ? (topCap / 1_000_000).toFixed(2) + "M" : (topCap / 1_000).toFixed(1) + "K"}` : "n/a";
  await notifyTelegram(env, `📊 Ciel market monitor heartbeat\nDiscovered: ${discovered}\nValid markets: ${valid}\nCandidates: ${candidates}\n≥$90K market cap: ${capEligible}\nSnapshots: ${snapshots}\nTop market cap: ${capText}${topSymbol ? ` (${topSymbol})` : ""}\n\nCiel is monitoring established NadFun markets; market cap is the primary signal.`);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return statusWithDiagnostics(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "*/3 * * * *") {
      ctx.waitUntil((async () => {
        await base.scheduled(controller, env, ctx);
        try { await triggerEstablishedModelAnalysis(env); } catch (error) { console.error(`Established model trigger failed: ${String(error).slice(0, 1000)}`); }
      })());
      return;
    }
    if (controller.cron === "*/10 * * * *") {
      ctx.waitUntil((async () => {
        try { await primeMarketDiscovery(env); } catch (error) { console.error(`Market discovery prime failed: ${String(error).slice(0, 500)}`); }
        try { await base.scheduled(controller, env, ctx); } finally { await maybeSendHeartbeat(env); }
      })());
      return;
    }
    await base.scheduled(controller, env, ctx);
  }
};

export default worker;
