export interface Env {
  CIEL_STATE: KVNamespace;
  DB: D1Database;
  MARKET_DATA: R2Bucket;
  TRADING_ENGINE: DurableObjectNamespace;
  GEMINI_API_KEY_1?: string;
  GEMINI_API_KEY_2?: string;
  WALLET_PRIVATE_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TRADING_ENABLED: string;
  PAPER_TRADING: string;
  HOLDING_CHECK_MINUTES: string;
  GEMINI_MODEL: string;
  NAD_API_BASE_URL?: string;
  NAD_RPC_URL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "ciel", tradingEnabled: env.TRADING_ENABLED === "true", paperTrading: env.PAPER_TRADING === "true" });
    if (url.pathname === "/status") return json(await status(env));
    return new Response("Ciel trading service", { status: 200 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Two-minute holding/risk loop. Real execution remains explicitly disabled until
    // TRADING_ENABLED=true and PAPER_TRADING=false are configured by the operator.
    if (controller.cron === "*/2 * * * *") {
      ctx.waitUntil(runHoldingCheck(env));
    }
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(runMarketCycle(env));
    }
    if (controller.cron === "0 * * * *") {
      ctx.waitUntil(runModelMaintenance(env));
    }
  }
};

export class TradingEngine {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json().catch(() => ({}));
    await this.state.storage.put("lastEvent", { at: Date.now(), body });
    return json({ ok: true });
  }
}

async function runHoldingCheck(env: Env) {
  // TODO: wire NAD.FUN/Monad position reads here. This loop is deliberately kept
  // independent from AI so emergency risk rules can execute deterministically.
  await env.CIEL_STATE.put("last_holding_check", String(Date.now()));
}

async function runMarketCycle(env: Env) {
  // TODO: collect NAD.FUN token/trade data and persist normalized snapshots to D1/R2.
  await env.CIEL_STATE.put("last_market_cycle", String(Date.now()));
}

async function runModelMaintenance(env: Env) {
  // TODO: calculate baselines, detect regime changes, and send only meaningful
  // deviations to the two Gemini analysis agents.
  await env.CIEL_STATE.put("last_model_maintenance", String(Date.now()));
}

async function status(env: Env) {
  const keys = ["last_holding_check", "last_market_cycle", "last_model_maintenance"];
  const values = await Promise.all(keys.map(k => env.CIEL_STATE.get(k)));
  return {
    service: "ciel",
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    lastHoldingCheck: values[0],
    lastMarketCycle: values[1],
    lastModelMaintenance: values[2]
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
