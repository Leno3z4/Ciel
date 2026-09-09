import base, { type Env, TradingEngine } from "./index";
import { primeMarketDiscovery } from "./market_discovery";

export { TradingEngine };

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
      "lastIndexerSkipReason"
    ];
    for (const key of diagnostics) if (runtime[key] !== undefined) payload[key] = runtime[key];
    return new Response(JSON.stringify(payload), { status: response.status, headers: { "content-type": "application/json" } });
  } catch {
    return response;
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return statusWithDiagnostics(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "*/3 * * * *") {
      ctx.waitUntil((async () => {
        try { await primeMarketDiscovery(env); } catch (error) { console.error(`Market discovery prime failed: ${String(error).slice(0, 500)}`); }
        await base.scheduled(controller, env, ctx);
      })());
      return;
    }
    await base.scheduled(controller, env, ctx);
  }
};

export default worker;
