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
const PAPER_FAILURE_COUNT_KEY = "paper_execution_failure_count";
const PAPER_CIRCUIT_KEY = "paper_execution_circuit_open";
const RUNTIME_STATE_KEY = "ciel_runtime_state";

type PaperState = "CREATED" | "RISK_CHECKED" | "QUOTED" | "BALANCE_RESERVED" | "FILLED" | "POSITION_UPDATED" | "CONSUMED" | "REJECTED" | "FAILED";

type RuntimeState = {
  lastHoldingCheck?: number;
  lastMarketCycle?: number;
  lastModelMaintenance?: number;
  lastModelAnalyzed?: number;
  monUsd?: number;
  paperUnrealizedPnlUsd?: number;
  paperFailureCount?: number;
  paperCircuitOpen?: boolean;
};

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

async function readRuntimeState(env: Env): Promise<RuntimeState> {
  const raw = await env.CIEL_STATE.get(RUNTIME_STATE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as RuntimeState; } catch { return {}; }
}

async function writeRuntimeState(env: Env, patch: RuntimeState) {
  const current = await readRuntimeState(env);
  await env.CIEL_STATE.put(RUNTIME_STATE_KEY, JSON.stringify({ ...current, ...patch }));
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
    if (controller.cron === "*/3 * * * *") ctx.waitUntil(runMarketCycle(env));
    if (controller.cron === "0 * * * *") ctx.waitUntil(runModelMaintenance(env));
  }
};

export class TradingEngine {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json().catch(() => ({})) as { action?: string; signalId?: number };
    if (body.action === "paper-signal" && Number.isInteger(body.signalId)) return json(await executePaperSignal(this.env, body.signalId!));
    await this.state.storage.put("lastEvent", { at: Date.now(), body });
    return json({ ok: true });
  }
}

function positiveQuantitySql(column: string) { return `${column} <> '0'`; }

async function beginPaperExecution(env: Env, signal: { id: number; token_address: string; action: string }) {
  const key = `paper:${signal.id}`;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO paper_executions(signal_id,execution_key,token_address,side,state,created_ts_ms,updated_ts_ms)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(signal_id) DO NOTHING`).bind(signal.id, key, signal.token_address, signal.action, "CREATED", now, now).run();
  return { key, row: await env.DB.prepare("SELECT * FROM paper_executions WHERE signal_id=?").bind(signal.id).first<any>() };
}

async function setPaperState(env: Env, signalId: number, state: PaperState, fields: Record<string, unknown> = {}) {
  const keys = Object.keys(fields);
  const sets = ["state=?", "updated_ts_ms=?", ...keys.map(k => `${k}=?`)];
  const values = [state, Date.now(), ...keys.map(k => fields[k])];
  await env.DB.prepare(`UPDATE paper_executions SET ${sets.join(",")} WHERE signal_id=?`).bind(...values, signalId).run();
}

async function failPaperExecution(env: Env, signalId: number, error: unknown) {
  const message = String(error).slice(0, 1000);
  await setPaperState(env, signalId, "FAILED", { error: message });
  const raw = Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0");
  const count = Number.isFinite(raw) ? raw + 1 : 1;
  await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, String(count));
  if (count >= 3) await env.CIEL_STATE.put(PAPER_CIRCUIT_KEY, "true");
  await writeRuntimeState(env, { paperFailureCount: count, paperCircuitOpen: count >= 3 });
}

async function executePaperSignal(env: Env, signalId: number) {
  if (env.TRADING_ENABLED === "true") return { ok: false, skipped: "live trading flag is enabled; paper executor is disabled" };
  if (env.PAPER_TRADING !== "true") return { ok: false, skipped: "paper trading disabled" };
  if (await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true") return { ok: false, skipped: "paper execution circuit breaker is open" };
  const signal = await env.DB.prepare("SELECT id,token_address,action,confidence,consumed_ts_ms FROM signals WHERE id=?").bind(signalId).first<{ id: number; token_address: string; action: string; confidence: number; consumed_ts_ms: number | null }>();
  if (!signal) return { ok: false, skipped: "signal missing" };
  const execution = await beginPaperExecution(env, signal);
  const existing = execution.row;
  if (existing?.state === "CONSUMED") return { ok: true, skipped: "paper execution already consumed", executionState: existing.state };
  if (existing?.state === "REJECTED") return { ok: false, skipped: existing.error || "paper execution rejected" };
  if (signal.consumed_ts_ms !== null && existing?.state === "CREATED") {
    await setPaperState(env, signalId, "REJECTED", { error: "signal was already consumed" });
    return { ok: false, skipped: "signal was already consumed" };
  }
  const token = signal.token_address as `0x${string}`;
  const state = await readRuntimeState(env);
  const monUsd = Number(state.monUsd || await env.CIEL_STATE.get("mon_usd"));
  const meta = await env.DB.prepare("SELECT decimals,liquidity_usd FROM tokens WHERE address=?").bind(token).first<{ decimals: number; liquidity_usd: number }>();
  const current = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1").bind(token).first<{ price_usd: number }>();
  const previous = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1 OFFSET 1").bind(token).first<{ price_usd: number }>();
  const liquidityUsd = Number(meta?.liquidity_usd || 0);
  const priceChangePct = previous?.price_usd && current?.price_usd ? ((current.price_usd - previous.price_usd) / previous.price_usd) * 100 : 0;
  const client = publicClient(env.NAD_RPC_URL);
  try {
    if (signal.action === "BUY") {
      const balance = await getPaperBalance(env);
      const amountMon = Math.min(PAPER_MAX_BUY_MON, balance);
      if (!(amountMon > 0) || !(monUsd > 0)) return consumeSignal(env, signalId, "paper skipped: insufficient balance or MON/USD price");
      const amountIn = BigInt(Math.floor(amountMon * 1e18));
      const tokenOut = await quoteBuy(client, token, amountIn);
      if (tokenOut <= 0n) return consumeSignal(env, signalId, "paper skipped: fresh buy quote returned zero");
      const decimals = Number(meta?.decimals || 18);
      const position = await env.DB.prepare("SELECT quantity,entry_price_usd FROM positions WHERE token_address=?").bind(token).first<{ quantity: string; entry_price_usd: number }>();
      const existingQty = BigInt(position?.quantity || "0");
      const fillPriceUsd = (amountMon * monUsd) / (Number(tokenOut) / 10 ** decimals);
      const totalTokenUnits = existingQty + tokenOut;
      const totalToken = Number(totalTokenUnits) / 10 ** decimals;
      const positionValueUsd = totalToken * fillPriceUsd;
      const portfolioValueMon = balance + positionValueUsd / monUsd;
      const positionPct = portfolioValueMon > 0 ? (positionValueUsd / monUsd / portfolioValueMon) * 100 : 0;
      const gate = riskGate({ confidence: Number(signal.confidence || 0), liquidityUsd, slippageBps: PAPER_SLIPPAGE_BPS, portfolioExposurePct: positionPct, positionPct, priceChangePct });
      await setPaperState(env, signalId, gate.allowed ? "RISK_CHECKED" : "REJECTED", { error: gate.allowed ? null : gate.reasons.join(", "), quantity: tokenOut.toString(), fill_price_usd: fillPriceUsd });
      if (!gate.allowed) return consumeSignal(env, signalId, `paper BUY blocked: ${gate.reasons.join(", ")}`, true);
      await setPaperState(env, signalId, "QUOTED", { quantity: tokenOut.toString(), fill_price_usd: fillPriceUsd, balance_before_mon: balance, balance_after_mon: balance - amountMon, position_quantity_after: totalTokenUnits.toString() });
      const currentBalance = await getPaperBalance(env);
      const expectedAfter = balance - amountMon;
      if (Math.abs(currentBalance - expectedAfter) > 1e-9) {
        if (Math.abs(currentBalance - balance) < 1e-9) await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(expectedAfter));
        else throw new Error("paper balance changed unexpectedly during BUY reservation");
      }
      await setPaperState(env, signalId, "BALANCE_RESERVED", {});
      await env.DB.prepare("INSERT OR IGNORE INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error,execution_key) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(token, Date.now(), "BUY", tokenOut.toString(), fillPriceUsd, null, "paper", "filled", null, execution.key).run();
      await setPaperState(env, signalId, "FILLED", {});
      const entryPrice = existingQty === 0n ? fillPriceUsd : Number(position?.entry_price_usd || fillPriceUsd);
      await env.DB.prepare(`INSERT INTO positions(token_address,quantity,entry_price_usd,entry_ts_ms,last_price_usd,updated_ts_ms)
        VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET quantity=excluded.quantity,entry_price_usd=CASE WHEN positions.quantity='0' THEN excluded.entry_price_usd ELSE positions.entry_price_usd END,entry_ts_ms=CASE WHEN positions.quantity='0' THEN excluded.entry_ts_ms ELSE positions.entry_ts_ms END,last_price_usd=excluded.last_price_usd,updated_ts_ms=excluded.updated_ts_ms`).bind(token, totalTokenUnits.toString(), entryPrice, Date.now(), fillPriceUsd, Date.now()).run();
      await setPaperState(env, signalId, "POSITION_UPDATED", {});
      await markConsumed(env, signalId);
      await setPaperState(env, signalId, "CONSUMED", {});
      await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, "0");
      await env.CIEL_STATE.delete(PAPER_CIRCUIT_KEY);
      await writeRuntimeState(env, { paperFailureCount: 0, paperCircuitOpen: false });
      await notifyTelegram(env, `📝 Ciel PAPER BUY\nToken: ${token}\nSpend: ${amountMon.toFixed(6)} MON\nTokens: ${tokenOut.toString()}\nFill: $${fillPriceUsd.toFixed(8)}`);
      return { ok: true, action: "BUY", amountMon, quantity: tokenOut.toString(), fillPriceUsd, executionState: "CONSUMED" };
    }
    if (signal.action === "SELL") {
      const position = await env.DB.prepare(`SELECT quantity,entry_price_usd FROM positions WHERE token_address=? AND ${positiveQuantitySql("quantity")}`).bind(token).first<{ quantity: string; entry_price_usd: number }>();
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
      await setPaperState(env, signalId, gate.allowed ? "RISK_CHECKED" : "REJECTED", { error: gate.allowed ? null : gate.reasons.join(", "), quantity: quantity.toString(), quote_out: quoteOut.toString(), fill_price_usd: fillPriceUsd });
      if (!gate.allowed) return consumeSignal(env, signalId, `paper SELL blocked: ${gate.reasons.join(", ")}`, true);
      const pnlUsd = (fillPriceUsd - Number(position.entry_price_usd || fillPriceUsd)) * quantityUnits;
      const expectedAfter = balance + proceedsMon;
      await setPaperState(env, signalId, "QUOTED", { balance_before_mon: balance, balance_after_mon: expectedAfter, position_quantity_after: "0", realized_pnl_usd: pnlUsd });
      const currentBalance = await getPaperBalance(env);
      if (Math.abs(currentBalance - expectedAfter) > 1e-9) {
        if (Math.abs(currentBalance - balance) < 1e-9) await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(expectedAfter));
        else throw new Error("paper balance changed unexpectedly during SELL reservation");
      }
      await setPaperState(env, signalId, "BALANCE_RESERVED", {});
      const realized = Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0") + pnlUsd;
      await env.CIEL_STATE.put(PAPER_REALIZED_PNL_KEY, String(realized));
      await env.DB.prepare("INSERT OR IGNORE INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error,execution_key) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(token, Date.now(), "SELL", quantity.toString(), fillPriceUsd, null, "paper", "filled", null, execution.key).run();
      await setPaperState(env, signalId, "FILLED", {});
      await env.DB.prepare("UPDATE positions SET quantity='0',last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(fillPriceUsd, Date.now(), token).run();
      await setPaperState(env, signalId, "POSITION_UPDATED", {});
      await markConsumed(env, signalId);
      await setPaperState(env, signalId, "CONSUMED", {});
      await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, "0");
      await env.CIEL_STATE.delete(PAPER_CIRCUIT_KEY);
      await writeRuntimeState(env, { paperFailureCount: 0, paperCircuitOpen: false });
      await notifyTelegram(env, `📝 Ciel PAPER SELL\nToken: ${token}\nProceeds: ${proceedsMon.toFixed(6)} MON\nFill: $${fillPriceUsd.toFixed(8)}\nRealized P&L: $${pnlUsd.toFixed(4)}`);
      return { ok: true, action: "SELL", proceedsMon, pnlUsd, executionState: "CONSUMED" };
    }
    return consumeSignal(env, signalId, `paper ${signal.action} not executable`);
  } catch (error) {
    await failPaperExecution(env, signalId, error);
    await notifyTelegram(env, `⚠️ Ciel paper execution failed\nSignal: ${signalId}\n${String(error).slice(0, 500)}`);
    return { ok: false, failed: true, error: String(error).slice(0, 500) };
  }
}

async function consumeSignal(env: Env, signalId: number, reason: string, alreadyRejected = false) {
  await markConsumed(env, signalId);
  if (!alreadyRejected) await setPaperState(env, signalId, "REJECTED", { error: reason });
  await notifyTelegram(env, `ℹ️ Ciel paper signal consumed\nSignal: ${signalId}\n${reason}`);
  return { ok: false, skipped: reason };
}

async function markConsumed(env: Env, signalId: number) {
  await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=? AND consumed_ts_ms IS NULL").bind(Date.now(), signalId).run();
}

async function getPaperBalance(env: Env) {
  const raw = await env.CIEL_STATE.get(PAPER_BALANCE_KEY);
  if (raw === null) { await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(PAPER_INITIAL_BALANCE_MON)); return PAPER_INITIAL_BALANCE_MON; }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : PAPER_INITIAL_BALANCE_MON;
}

async function runHoldingCheck(env: Env) {
  const state = await readRuntimeState(env);
  const monUsd = Number(state.monUsd || await env.CIEL_STATE.get("mon_usd"));
  if (!(monUsd > 0)) return;
  if (env.PAPER_TRADING === "true" && env.TRADING_ENABLED !== "true") await runPaperPositionMonitoring(env, monUsd);
  const address = walletAddress(env.WALLET_PRIVATE_KEY);
  if (!address) {
    await writeRuntimeState(env, { lastHoldingCheck: Date.now() });
    return;
  }
  const client = publicClient(env.NAD_RPC_URL);
  const rows = await env.DB.prepare(`SELECT p.token_address,p.quantity,p.entry_price_usd,p.last_price_usd,t.decimals FROM positions p LEFT JOIN tokens t ON t.address=p.token_address WHERE ${positiveQuantitySql("p.quantity")}`).all<{ token_address: string; quantity: string; entry_price_usd: number; last_price_usd: number; decimals: number }>();
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
      if (changePct <= -15) {
        const totalQuote = await quoteSell(client, token, balance);
        await notifyTelegram(env, `🚨 Ciel emergency exit candidate\nToken: ${token}\nMove: ${changePct.toFixed(2)}%\nPrice: $${currentUsd.toFixed(8)}\nQuote: ${(Number(totalQuote) / 1e18).toFixed(6)} MON`);
        if (env.TRADING_ENABLED === "true" && env.PAPER_TRADING !== "true" && env.WALLET_PRIVATE_KEY) {
          const amountOutMin = totalQuote * BigInt(10000 - PAPER_SLIPPAGE_BPS) / 10000n;
          const tx = await sellToNative({ rpcUrl: env.NAD_RPC_URL, privateKey: env.WALLET_PRIVATE_KEY, token, amountIn: balance, amountOutMin });
          await env.DB.prepare("INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error) VALUES(?,?,?,?,?,?,?,?,?)").bind(token, Date.now(), "SELL", balance.toString(), currentUsd, tx, "live", "submitted", null).run();
        }
      }
      if (currentUsd > 0) await env.DB.prepare("UPDATE positions SET last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(currentUsd, Date.now(), token).run();
    } catch (error) { await notifyTelegram(env, `⚠️ Ciel holding check failed for ${p.token_address}: ${String(error).slice(0, 300)}`); }
  }
  await writeRuntimeState(env, { lastHoldingCheck: Date.now() });
}

async function runPaperPositionMonitoring(env: Env, monUsd: number) {
  const rows = await env.DB.prepare(`SELECT p.token_address,p.quantity,p.entry_price_usd,t.decimals FROM positions p LEFT JOIN tokens t ON t.address=p.token_address WHERE ${positiveQuantitySql("p.quantity")}`).all<{ token_address: string; quantity: string; entry_price_usd: number; decimals: number }>();
  const client = publicClient(env.NAD_RPC_URL);
  let unrealizedUsd = 0;
  for (const p of rows.results ?? []) {
    try {
      const token = p.token_address as `0x${string}`;
      const decimals = Number(p.decimals || 18);
      const qty = BigInt(p.quantity);
      const quote = await quoteSell(client, token, qty);
      const valueUsd = Number(quote) / 1e18 * monUsd;
      const qtyUnits = Number(qty) / 10 ** decimals;
      unrealizedUsd += valueUsd - Number(p.entry_price_usd || 0) * qtyUnits;
      await env.DB.prepare("UPDATE positions SET last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(qtyUnits > 0 ? valueUsd / qtyUnits : 0, Date.now(), token).run();
    } catch (error) { await notifyTelegram(env, `⚠️ Ciel paper position monitor failed for ${p.token_address}: ${String(error).slice(0, 250)}`); }
  }
  // P&L telemetry is useful hourly, but does not need a KV write every two minutes.
  await writeRuntimeState(env, { paperUnrealizedPnlUsd: unrealizedUsd });
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
    await writeRuntimeState(env, { lastMarketCycle: Date.now() });
    if (result) await notifyTelegram(env, `📡 Ciel indexer\nBlocks: ${result.fromBlock}-${result.toBlock}\nCreate ${result.creates} | Buy ${result.buys} | Sell ${result.sells} | Graduate ${result.graduates} | Sync ${result.syncs} | Snapshots ${result.snapshots}`);
  } catch (error) {
    await writeRuntimeState(env, { lastMarketCycle: Date.now() });
    await notifyTelegram(env, `⚠️ Ciel market cycle failed: ${String(error).slice(0, 400)}`);
  }
}

async function runModelMaintenance(env: Env) {
  const tokens = await env.DB.prepare("SELECT address FROM tokens WHERE market_cap_usd > 0 AND liquidity_usd > 0 ORDER BY market_cap_usd DESC,last_seen_ms DESC LIMIT 25").all<{ address: string }>();
  let analyzed = 0;
  for (const row of tokens.results ?? []) {
    const data = await env.DB.prepare("SELECT token_address AS token,ts_ms AS tsMs,price_usd AS priceUsd,market_cap_usd AS marketCapUsd,liquidity_usd AS liquidityUsd,volume_5m_usd AS volume5mUsd,buys_5m AS buys5m,sells_5m AS sells5m,holders FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 288").bind(row.address).all<Snapshot>();
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
  await writeRuntimeState(env, { lastModelMaintenance: Date.now(), lastModelAnalyzed: analyzed });
}

async function runPaperSignalById(env: Env, signalId: number) {
  if (env.PAPER_TRADING !== "true" || env.TRADING_ENABLED === "true") return;
  const id = env.TRADING_ENGINE.idFromName("paper");
  await env.TRADING_ENGINE.get(id).fetch("https://ciel.internal/paper", { method: "POST", body: JSON.stringify({ action: "paper-signal", signalId }) });
}

async function status(env: Env) {
  const state = await readRuntimeState(env);
  const [indexer, balance, realized] = await Promise.all([
    env.CIEL_STATE.get("indexer_state"),
    env.CIEL_STATE.get(PAPER_BALANCE_KEY),
    env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY)
  ]);
  let indexerState: { nextBlock?: string; latestBlock?: string; lastSnapshotCount?: number } = {};
  try { if (indexer) indexerState = JSON.parse(indexer); } catch {}
  return {
    service: "ciel",
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    lastHoldingCheck: state.lastHoldingCheck ?? null,
    lastMarketCycle: state.lastMarketCycle ?? null,
    lastModelMaintenance: state.lastModelMaintenance ?? null,
    indexerNextBlock: indexerState.nextBlock ?? null,
    indexerLatestBlock: indexerState.latestBlock ?? null,
    lastModelAnalyzed: state.lastModelAnalyzed ?? null,
    monUsd: state.monUsd ?? null,
    lastSnapshotCount: indexerState.lastSnapshotCount ?? null,
    paperBalanceMon: balance ?? String(PAPER_INITIAL_BALANCE_MON),
    paperRealizedPnlUsd: realized ?? "0",
    paperUnrealizedPnlUsd: state.paperUnrealizedPnlUsd ?? "0",
    paperExecutionFailureCount: state.paperFailureCount ?? 0,
    paperExecutionCircuitOpen: state.paperCircuitOpen ?? false
  };
}

function json(data: unknown, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
