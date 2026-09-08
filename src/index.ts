import { indexNadFun } from "./indexer";
import { publicClient, tokenBalance, quoteSell, walletAddress, sellToNative } from "./nadfun";
import { buildBaseline, deviationScore, askGemini, type Snapshot } from "./model";
import { riskGate } from "./risk";
import { notifyTelegram } from "./telegram";

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
    if (controller.cron === "*/2 * * * *") ctx.waitUntil(runHoldingCheck(env));
    if (controller.cron === "*/5 * * * *") ctx.waitUntil(runMarketCycle(env));
    if (controller.cron === "0 * * * *") ctx.waitUntil(runModelMaintenance(env));
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
  const address = await walletAddress(env.WALLET_PRIVATE_KEY);
  if (!address) { await env.CIEL_STATE.put("last_holding_check", String(Date.now())); return; }
  const client = publicClient(env.NAD_RPC_URL);
  const rows = await env.DB.prepare("SELECT token_address, quantity, entry_price_usd, last_price_usd FROM positions WHERE quantity > 0").all<{ token_address: string; quantity: string; entry_price_usd: number; last_price_usd: number }>();
  for (const p of rows.results ?? []) {
    try {
      const token = p.token_address as `0x${string}`;
      const balance = await tokenBalance(client, token, address);
      if (balance === 0n) continue;
      const nativeOut = await quoteSell(client, token, balance);
      const current = Number(nativeOut) / 1e18;
      const last = Number(p.last_price_usd || p.entry_price_usd || 0);
      const changePct = last > 0 ? ((current - last) / last) * 100 : 0;
      const gate = riskGate({ confidence: 1, liquidityUsd: 1e9, slippageBps: 0, portfolioExposurePct: 0, positionPct: 0, priceChangePct: changePct });
      if (changePct <= -15) {
        await notifyTelegram(env, `🚨 Ciel emergency exit candidate\nToken: ${token}\nMove: ${changePct.toFixed(2)}%\nQuote: ${current.toFixed(6)} MON\nReason: ${gate.reasons.join(", ")}`);
        if (env.TRADING_ENABLED === "true" && env.PAPER_TRADING !== "true" && env.WALLET_PRIVATE_KEY) {
          const amountOutMin = nativeOut * 9500n / 10000n;
          const tx = await sellToNative({ rpcUrl: env.NAD_RPC_URL, privateKey: env.WALLET_PRIVATE_KEY, token, amountIn: balance, amountOutMin });
          await notifyTelegram(env, `🛡️ Ciel emergency sell submitted\nToken: ${token}\nTx: ${tx}`);
        }
      }
      await env.DB.prepare("UPDATE positions SET last_price_usd=?, updated_ts_ms=? WHERE token_address=?").bind(current, Date.now(), token).run();
    } catch (error) { await notifyTelegram(env, `⚠️ Ciel holding check failed for ${p.token_address}: ${String(error).slice(0, 300)}`); }
  }
  await env.CIEL_STATE.put("last_holding_check", String(Date.now()));
}

async function runMarketCycle(env: Env) {
  try {
    const result = await indexNadFun(env, 3000);
    await env.CIEL_STATE.put("last_market_cycle", String(Date.now()));
    if (result) await notifyTelegram(env, `📡 Ciel indexer\nBlocks: ${result.fromBlock}-${result.toBlock}\nCreate ${result.creates} | Buy ${result.buys} | Sell ${result.sells} | Graduate ${result.graduates} | Sync ${result.syncs}`);
  } catch (error) {
    await env.CIEL_STATE.put("last_market_error", String(error));
    await notifyTelegram(env, `⚠️ Ciel market cycle failed: ${String(error).slice(0, 400)}`);
  }
}

async function runModelMaintenance(env: Env) {
  const tokens = await env.DB.prepare("SELECT address FROM tokens ORDER BY market_cap_usd DESC, last_seen_ms DESC LIMIT 25").all<{ address: string }>();
  let analyzed = 0;
  for (const row of tokens.results ?? []) {
    const data = await env.DB.prepare("SELECT token_address AS token, ts_ms AS tsMs, price_usd AS priceUsd, market_cap_usd AS marketCapUsd, liquidity_usd AS liquidityUsd, volume_5m_usd AS volume5mUsd, buys_5m AS buys5m, sells_5m AS sells5m, holders FROM market_snapshots WHERE token_address=? ORDER BY ts_ms DESC LIMIT 288").bind(row.address).all<Snapshot>();
    const snapshots = (data.results ?? []).reverse();
    if (snapshots.length < 12) continue;
    const baseline = buildBaseline(snapshots);
    const current = snapshots[snapshots.length - 1];
    const score = deviationScore(current, baseline);
    if (score < 0.45) continue;
    const [market, regime] = await Promise.all([
      askGemini(env.GEMINI_API_KEY_1, env.GEMINI_MODEL, "market", current, baseline, score),
      askGemini(env.GEMINI_API_KEY_2, env.GEMINI_MODEL, "regime", current, baseline, score)
    ]);
    const chosen = regime && market && regime.confidence >= market.confidence ? regime : market;
    if (!chosen) continue;
    const confidence = Math.max(0, Math.min(1, chosen.confidence));
    const action = chosen.action === "BUY" && confidence >= 0.72 ? "BUY" : chosen.action === "SELL" ? "SELL" : "HOLD";
    await env.DB.prepare("INSERT INTO signals(token_address,ts_ms,action,confidence,expected_low,expected_high,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?,?,?)").bind(row.address, Date.now(), action, confidence, chosen.expectedLowUsd, chosen.expectedHighUsd, Math.max(score, chosen.anomalyScore), "gemini-dual", chosen.rationale.slice(0, 1000)).run();
    await notifyTelegram(env, `🧠 Ciel ${action}\nToken: ${row.address}\nConfidence: ${(confidence * 100).toFixed(1)}%\nAnomaly: ${score.toFixed(2)}\nRegime: ${chosen.regime}\n${chosen.rationale.slice(0, 500)}`);
    analyzed++;
  }
  await env.CIEL_STATE.put("last_model_maintenance", String(Date.now()));
  await env.CIEL_STATE.put("last_model_analyzed", String(analyzed));
}

async function status(env: Env) {
  const keys = ["last_holding_check", "last_market_cycle", "last_model_maintenance", "indexer_next_block", "indexer_latest_block", "last_model_analyzed"];
  const values = await Promise.all(keys.map(k => env.CIEL_STATE.get(k)));
  return { service: "ciel", tradingEnabled: env.TRADING_ENABLED === "true", paperTrading: env.PAPER_TRADING === "true", lastHoldingCheck: values[0], lastMarketCycle: values[1], lastModelMaintenance: values[2], indexerNextBlock: values[3], indexerLatestBlock: values[4], lastModelAnalyzed: values[5] };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
