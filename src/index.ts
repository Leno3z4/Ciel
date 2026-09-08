import { indexNadFun } from "./indexer";
import { publicClient, tokenBalance, quoteSell, quoteBuy, walletAddress, sellToNative } from "./nadfun";
import { buildBaseline, deviationScore, askGemini, type Snapshot } from "./model";
import { riskGate } from "./risk";
import { notifyTelegram } from "./telegram";

const PAPER_INITIAL_BALANCE_MON = 100;
const PAPER_MAX_BUY_MON = 1;
const PAPER_SLIPPAGE_BPS = 500;
const PAPER_BALANCE_KEY = "paper_balance_mon";
const PAPER_REALIZED_PNL_KEY = "paper_realized_pnl_usd";

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
    const body = await request.json().catch(() => ({})) as { action?: string; signalId?: number };
    if (body.action === "paper-signal" && Number.isInteger(body.signalId)) {
      return json(await executePaperSignal(this.env, body.signalId!));
    }
    await this.state.storage.put("lastEvent", { at: Date.now(), body });
    return json({ ok: true });
  }
}

async function executePaperSignal(env: Env, signalId: number) {
  if (env.TRADING_ENABLED === "true") return { ok: false, skipped: "live trading flag is enabled; paper executor is disabled" };
  if (env.PAPER_TRADING !== "true") return { ok: false, skipped: "paper trading disabled" };

  const signal = await env.DB.prepare("SELECT id,token_address,action,confidence FROM signals WHERE id=? AND consumed_ts_ms IS NULL").bind(signalId).first<{ id: number; token_address: string; action: string; confidence: number }>();
  if (!signal) return { ok: false, skipped: "signal already consumed or missing" };
  const now = Date.now();
  const token = signal.token_address as `0x${string}`;
  const monUsd = Number(await env.CIEL_STATE.get("mon_usd"));
  const meta = await env.DB.prepare("SELECT decimals,liquidity_usd FROM tokens WHERE address=?").bind(token).first<{ decimals: number; liquidity_usd: number }>();
  const current = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1").bind(token).first<{ price_usd: number }>();
  const previous = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1 OFFSET 1").bind(token).first<{ price_usd: number }>();
  const liquidityUsd = Number(meta?.liquidity_usd || 0);
  const priceChangePct = previous?.price_usd && current?.price_usd ? ((current.price_usd - previous.price_usd) / previous.price_usd) * 100 : 0;
  const client = publicClient(env.NAD_RPC_URL);

  if (signal.action === "BUY") {
    const balance = await getPaperBalance(env);
    const amountMon = Math.min(PAPER_MAX_BUY_MON, balance);
    if (!(amountMon > 0) || !(monUsd > 0)) return consumeSignal(env, signalId, "paper skipped: insufficient balance or MON/USD price");
    const amountIn = BigInt(Math.floor(amountMon * 1e18));
    const tokenOut = await quoteBuy(client, token, amountIn);
    if (tokenOut <= 0n) return consumeSignal(env, signalId, "paper skipped: fresh buy quote returned zero");
    const position = await env.DB.prepare("SELECT quantity FROM positions WHERE token_address=?").bind(token).first<{ quantity: string }>();
    const existingQty = BigInt(position?.quantity || "0");
    const decimals = Number(meta?.decimals || 18);
    const totalTokenUnits = existingQty + tokenOut;
    const totalToken = Number(totalTokenUnits) / 10 ** decimals;
    const positionValueUsd = totalToken * (amountMon * monUsd / (Number(tokenOut) / 10 ** decimals));
    const portfolioValueMon = balance + positionValueUsd / monUsd;
    const positionPct = portfolioValueMon > 0 ? (positionValueUsd / monUsd / portfolioValueMon) * 100 : 0;
    const gate = riskGate({ confidence: Number(signal.confidence || 0), liquidityUsd, slippageBps: PAPER_SLIPPAGE_BPS, portfolioExposurePct: positionPct, positionPct, priceChangePct });
    if (!gate.allowed) return consumeSignal(env, signalId, `paper BUY blocked: ${gate.reasons.join(", ")}`);

    const fillPriceUsd = (amountMon * monUsd) / (Number(tokenOut) / 10 ** decimals);
    const newQty = existingQty + tokenOut;
    await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(balance - amountMon));
    await env.DB.prepare("INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error) VALUES(?,?,?,?,?,?,?,?,?)").bind(token, now, "BUY", tokenOut.toString(), fillPriceUsd, null, "paper", "filled", null).run();
    await env.DB.prepare(`INSERT INTO positions(token_address,quantity,entry_price_usd,entry_ts_ms,last_price_usd,updated_ts_ms)
      VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET quantity=excluded.quantity,entry_price_usd=CASE WHEN positions.quantity='0' THEN excluded.entry_price_usd ELSE positions.entry_price_usd END,entry_ts_ms=CASE WHEN positions.quantity='0' THEN excluded.entry_ts_ms ELSE positions.entry_ts_ms END,last_price_usd=excluded.last_price_usd,updated_ts_ms=excluded.updated_ts_ms`)
      .bind(token, newQty.toString(), fillPriceUsd, now, fillPriceUsd, now).run();
    await markConsumed(env, signalId);
    await notifyTelegram(env, `📝 Ciel PAPER BUY\nToken: ${token}\nSpend: ${amountMon.toFixed(6)} MON\nTokens: ${tokenOut.toString()}\nFill: $${fillPriceUsd.toFixed(8)}`);
    return { ok: true, action: "BUY", amountMon, quantity: tokenOut.toString(), fillPriceUsd };
  }

  if (signal.action === "SELL") {
    const position = await env.DB.prepare("SELECT quantity,entry_price_usd FROM positions WHERE token_address=? AND CAST(quantity AS INTEGER)>0").bind(token).first<{ quantity: string; entry_price_usd: number }>();
    if (!position) return consumeSignal(env, signalId, "paper SELL skipped: no position");
    const quantity = BigInt(position.quantity);
    const quoteOut = await quoteSell(client, token, quantity);
    if (quoteOut <= 0n || !(monUsd > 0)) return consumeSignal(env, signalId, "paper SELL skipped: fresh sell quote returned zero or no MON/USD price");
    const decimals = Number(meta?.decimals || 18);
    const quantityUnits = Number(quantity) / 10 ** decimals;
    const proceedsMon = Number(quoteOut) / 1e18;
    const fillPriceUsd = quantityUnits > 0 ? proceedsMon * monUsd / quantityUnits : 0;
    const balance = await getPaperBalance(env);
    const positionValueUsd = proceedsMon * monUsd;
    const portfolioValueMon = balance + positionValueUsd / monUsd;
    const positionPct = portfolioValueMon > 0 ? (positionValueUsd / monUsd / portfolioValueMon) * 100 : 0;
    const gate = riskGate({ confidence: Number(signal.confidence || 0), liquidityUsd, slippageBps: PAPER_SLIPPAGE_BPS, portfolioExposurePct: positionPct, positionPct, priceChangePct });
    if (!gate.allowed) return consumeSignal(env, signalId, `paper SELL blocked: ${gate.reasons.join(", ")}`);

    const pnlUsd = (fillPriceUsd - Number(position.entry_price_usd || fillPriceUsd)) * quantityUnits;
    await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(balance + proceedsMon));
    await env.CIEL_STATE.put(PAPER_REALIZED_PNL_KEY, String(Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0") + pnlUsd));
    await env.DB.prepare("INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error) VALUES(?,?,?,?,?,?,?,?,?)").bind(token, now, "SELL", quantity.toString(), fillPriceUsd, null, "paper", "filled", null).run();
    await env.DB.prepare("UPDATE positions SET quantity='0',last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(fillPriceUsd, now, token).run();
    await markConsumed(env, signalId);
    await notifyTelegram(env, `📝 Ciel PAPER SELL\nToken: ${token}\nProceeds: ${proceedsMon.toFixed(6)} MON\nFill: $${fillPriceUsd.toFixed(8)}\nRealized P&L: $${pnlUsd.toFixed(4)}`);
    return { ok: true, action: "SELL", proceedsMon, pnlUsd };
  }

  return consumeSignal(env, signalId, `paper ${signal.action} not executable`);
}

async function consumeSignal(env: Env, signalId: number, reason: string) {
  await markConsumed(env, signalId);
  await notifyTelegram(env, `ℹ️ Ciel paper signal consumed\nSignal: ${signalId}\n${reason}`);
  return { ok: false, skipped: reason };
}

async function markConsumed(env: Env, signalId: number) {
  await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=? AND consumed_ts_ms IS NULL").bind(Date.now(), signalId).run();
}

async function getPaperBalance(env: Env) {
  const raw = await env.CIEL_STATE.get(PAPER_BALANCE_KEY);
  if (raw === null) {
    await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(PAPER_INITIAL_BALANCE_MON));
    return PAPER_INITIAL_BALANCE_MON;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : PAPER_INITIAL_BALANCE_MON;
}

async function runHoldingCheck(env: Env) {
  const monUsd = Number(await env.CIEL_STATE.get("mon_usd"));
  if (!(monUsd > 0)) { await env.CIEL_STATE.put("last_holding_check", String(Date.now())); return; }
  if (env.PAPER_TRADING === "true" && env.TRADING_ENABLED !== "true") await runPaperPositionMonitoring(env);

  const address = walletAddress(env.WALLET_PRIVATE_KEY);
  if (!address) { await env.CIEL_STATE.put("last_holding_check", String(Date.now())); return; }
  const client = publicClient(env.NAD_RPC_URL);
  const rows = await env.DB.prepare("SELECT p.token_address, p.quantity, p.entry_price_usd, p.last_price_usd, t.decimals FROM positions p LEFT JOIN tokens t ON t.address=p.token_address WHERE CAST(p.quantity AS INTEGER) > 0").all<{ token_address: string; quantity: string; entry_price_usd: number; last_price_usd: number; decimals: number }>();
  for (const p of rows.results ?? []) {
    try {
      const token = p.token_address as `0x${string}`;
      const balance = await tokenBalance(client, token, address);
      if (balance === 0n) continue;
      const decimals = Number(p.decimals || 18);
      const unitQuote = await quoteSell(client, token, 10n ** BigInt(decimals));
      const currentUsd = Number(unitQuote) / 1e18 * monUsd;
      const last = Number(p.last_price_usd || p.entry_price_usd || 0);
      const changePct = last > 0 && currentUsd > 0 ? ((currentUsd - last) / last) * 100 : 0;
      const gate = riskGate({ confidence: 1, liquidityUsd: 1e9, slippageBps: 0, portfolioExposurePct: 0, positionPct: 0, priceChangePct: changePct });
      if (changePct <= -15) {
        const totalQuote = await quoteSell(client, token, balance);
        await notifyTelegram(env, `🚨 Ciel emergency exit candidate\nToken: ${token}\nMove: ${changePct.toFixed(2)}%\nPrice: $${currentUsd.toFixed(8)}\nQuote: ${(Number(totalQuote) / 1e18).toFixed(6)} MON\nReason: ${gate.reasons.join(", ")}`);
        if (env.TRADING_ENABLED === "true" && env.PAPER_TRADING !== "true" && env.WALLET_PRIVATE_KEY) {
          const amountOutMin = totalQuote * 9500n / 10000n;
          const tx = await sellToNative({ rpcUrl: env.NAD_RPC_URL, privateKey: env.WALLET_PRIVATE_KEY, token, amountIn: balance, amountOutMin });
          await env.DB.prepare("INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error) VALUES(?,?,?,?,?,?,?,?,?)").bind(token, Date.now(), "SELL", balance.toString(), currentUsd, tx, "live", "submitted", null).run();
          await notifyTelegram(env, `🛡️ Ciel emergency sell submitted\nToken: ${token}\nTx: ${tx}`);
        }
      }
      if (currentUsd > 0) await env.DB.prepare("UPDATE positions SET last_price_usd=?, updated_ts_ms=? WHERE token_address=?").bind(currentUsd, Date.now(), token).run();
    } catch (error) { await notifyTelegram(env, `⚠️ Ciel holding check failed for ${p.token_address}: ${String(error).slice(0, 300)}`); }
  }
  await env.CIEL_STATE.put("last_holding_check", String(Date.now()));
}

async function runPaperPositionMonitoring(env: Env) {
  const rows = await env.DB.prepare("SELECT p.token_address,p.quantity,p.entry_price_usd,t.decimals FROM positions p LEFT JOIN tokens t ON t.address=p.token_address WHERE CAST(p.quantity AS INTEGER)>0").all<{ token_address: string; quantity: string; entry_price_usd: number; decimals: number }>();
  const client = publicClient(env.NAD_RPC_URL);
  let unrealizedUsd = 0;
  for (const p of rows.results ?? []) {
    try {
      const token = p.token_address as `0x${string}`;
      const decimals = Number(p.decimals || 18);
      const qty = BigInt(p.quantity);
      const quote = await quoteSell(client, token, qty);
      const monUsd = Number(await env.CIEL_STATE.get("mon_usd"));
      const valueUsd = Number(quote) / 1e18 * monUsd;
      const qtyUnits = Number(qty) / 10 ** decimals;
      unrealizedUsd += valueUsd - Number(p.entry_price_usd || 0) * qtyUnits;
      await env.DB.prepare("UPDATE positions SET last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(qtyUnits > 0 ? valueUsd / qtyUnits : 0, Date.now(), token).run();
    } catch (error) { await notifyTelegram(env, `⚠️ Ciel paper position monitor failed for ${p.token_address}: ${String(error).slice(0, 250)}`); }
  }
  await env.CIEL_STATE.put("paper_unrealized_pnl_usd", String(unrealizedUsd));
}

async function runPaperSignalCycle(env: Env) {
  if (env.PAPER_TRADING !== "true" || env.TRADING_ENABLED === "true") return;
  await getPaperBalance(env);
  const rows = await env.DB.prepare("SELECT id FROM signals WHERE consumed_ts_ms IS NULL AND action IN ('BUY','SELL') ORDER BY ts_ms ASC LIMIT 10").all<{ id: number }>();
  const id = env.TRADING_ENGINE.idFromName("paper");
  const stub = env.TRADING_ENGINE.get(id);
  for (const row of rows.results ?? []) await stub.fetch("https://ciel.internal/paper", { method: "POST", body: JSON.stringify({ action: "paper-signal", signalId: row.id }) });
}

async function runMarketCycle(env: Env) {
  try {
    const result = await indexNadFun(env, 3000);
    await env.CIEL_STATE.put("last_market_cycle", String(Date.now()));
    if (result) await notifyTelegram(env, `📡 Ciel indexer\nBlocks: ${result.fromBlock}-${result.toBlock}\nCreate ${result.creates} | Buy ${result.buys} | Sell ${result.sells} | Graduate ${result.graduates} | Sync ${result.syncs} | Snapshots ${result.snapshots}`);
  } catch (error) {
    await env.CIEL_STATE.put("last_market_error", String(error));
    await notifyTelegram(env, `⚠️ Ciel market cycle failed: ${String(error).slice(0, 400)}`);
  }
}

async function runModelMaintenance(env: Env) {
  const tokens = await env.DB.prepare("SELECT address FROM tokens WHERE market_cap_usd > 0 AND liquidity_usd > 0 ORDER BY market_cap_usd DESC, last_seen_ms DESC LIMIT 25").all<{ address: string }>();
  let analyzed = 0;
  for (const row of tokens.results ?? []) {
    const data = await env.DB.prepare("SELECT token_address AS token, ts_ms AS tsMs, price_usd AS priceUsd, market_cap_usd AS marketCapUsd, liquidity_usd AS liquidityUsd, volume_5m_usd AS volume5mUsd, buys_5m AS buys5m, sells_5m AS sells5m, holders FROM market_snapshots WHERE token_address=? AND price_usd > 0 ORDER BY ts_ms DESC LIMIT 288").bind(row.address).all<Snapshot>();
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
    const anomaly = Math.max(0, Math.min(1, Math.max(score, Number(chosen.anomalyScore) || 0)));
    const action = chosen.action === "BUY" && confidence >= 0.72 ? "BUY" : chosen.action === "SELL" && confidence >= 0.72 ? "SELL" : "HOLD";
    const inserted = await env.DB.prepare("INSERT INTO signals(token_address,ts_ms,action,confidence,expected_low,expected_high,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").bind(row.address, Date.now(), action, confidence, chosen.expectedLowUsd, chosen.expectedHighUsd, anomaly, "gemini-dual", chosen.rationale.slice(0, 1000)).first<{ id: number }>();
    await notifyTelegram(env, `🧠 Ciel ${action}\nToken: ${row.address}\nConfidence: ${(confidence * 100).toFixed(1)}%\nAnomaly: ${anomaly.toFixed(2)}\nRegime: ${chosen.regime}\n${chosen.rationale.slice(0, 500)}`);
    if (inserted?.id) await runPaperSignalById(env, inserted.id);
    analyzed++;
  }
  await runPaperSignalCycle(env);
  await env.CIEL_STATE.put("last_model_maintenance", String(Date.now()));
  await env.CIEL_STATE.put("last_model_analyzed", String(analyzed));
}

async function runPaperSignalById(env: Env, signalId: number) {
  if (env.PAPER_TRADING !== "true" || env.TRADING_ENABLED === "true") return;
  const id = env.TRADING_ENGINE.idFromName("paper");
  await env.TRADING_ENGINE.get(id).fetch("https://ciel.internal/paper", { method: "POST", body: JSON.stringify({ action: "paper-signal", signalId }) });
}

async function status(env: Env) {
  const keys = ["last_holding_check", "last_market_cycle", "last_model_maintenance", "indexer_next_block", "indexer_latest_block", "last_model_analyzed", "mon_usd", "indexer_last_snapshot_count", PAPER_BALANCE_KEY, PAPER_REALIZED_PNL_KEY, "paper_unrealized_pnl_usd"];
  const values = await Promise.all(keys.map(k => env.CIEL_STATE.get(k)));
  return { service: "ciel", tradingEnabled: env.TRADING_ENABLED === "true", paperTrading: env.PAPER_TRADING === "true", lastHoldingCheck: values[0], lastMarketCycle: values[1], lastModelMaintenance: values[2], indexerNextBlock: values[3], indexerLatestBlock: values[4], lastModelAnalyzed: values[5], monUsd: values[6], lastSnapshotCount: values[7], paperBalanceMon: values[8] ?? String(PAPER_INITIAL_BALANCE_MON), paperRealizedPnlUsd: values[9] ?? "0", paperUnrealizedPnlUsd: values[10] ?? "0" };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
