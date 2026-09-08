import { indexNadFun } from "./indexer";
import { publicClient, tokenBalance, quoteSell, quoteBuy, walletAddress, sellToNative } from "./nadfun";
import { buildBaseline, deviationScore, askGemini, type Snapshot } from "./model";
import { riskGate } from "./risk";
import { notifyTelegram } from "./telegram";

const PAPER_INITIAL_BALANCE_MON = 1000;
const PAPER_MAX_BUY_MON = 1;
const PAPER_SLIPPAGE_BPS = 500;
const PAPER_BALANCE_KEY = "paper_balance_mon";
const PAPER_REALIZED_PNL_KEY = "paper_realized_pnl_usd";
const PAPER_FAILURE_COUNT_KEY = "paper_execution_failure_count";
const PAPER_CIRCUIT_KEY = "paper_execution_circuit_open";
const RUNTIME_STATE_KEY = "ciel_runtime_state";
const RUNTIME_TELEMETRY_INTERVAL_MS = 10 * 60 * 1000;

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
  // Market-cycle telemetry is already persisted atomically with the indexer cursor.
  // Do not create a second KV write every three minutes.
  if (patch.lastMarketCycle !== undefined) {
    const { lastMarketCycle: _ignored, ...rest } = patch;
    patch = rest;
  }
  if (Object.keys(patch).length === 0) return;

  const current = await readRuntimeState(env);
  const holdingTelemetryOnly = Object.keys(patch).every((key) => key === "lastHoldingCheck" || key === "paperUnrealizedPnlUsd");
  if (holdingTelemetryOnly) {
    const lastPersisted = Number(current.lastHoldingCheck || 0);
    if (lastPersisted > 0 && Date.now() - lastPersisted < RUNTIME_TELEMETRY_INTERVAL_MS) return;
  }
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
  if (!address) return;
  const native = await publicClient(env.NAD_RPC_URL).getBalance({ address });
  if (native === 0n) return;
  const tokens = await env.DB.prepare("SELECT address,decimals FROM tokens WHERE graduated=1").all<{ address: string; decimals: number }>();
  for (const row of tokens.results || []) {
    const balance = await tokenBalance(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, address);
    if (balance > 0n) {
      const quote = await quoteSell(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, balance);
      if (quote > 0n) {
        const valueUsd = Number(quote) / 1e18 * monUsd;
        if (valueUsd > 0) await writeRuntimeState(env, { lastHoldingCheck: Date.now(), paperUnrealizedPnlUsd: undefined });
      }
    }
  }
  await writeRuntimeState(env, { lastHoldingCheck: Date.now() });
}

async function runPaperPositionMonitoring(env: Env, monUsd: number) {
  const rows = await env.DB.prepare(`SELECT p.token_address,p.quantity,p.entry_price_usd,s.price_usd
    FROM positions p LEFT JOIN market_snapshots s ON s.token_address=p.token_address
    WHERE ${positiveQuantitySql("p.quantity")} AND s.ts_ms=(SELECT MAX(s2.ts_ms) FROM market_snapshots s2 WHERE s2.token_address=p.token_address)`).all<{ token_address: string; quantity: string; entry_price_usd: number; price_usd: number }>();
  let totalUnrealized = 0;
  for (const row of rows.results || []) {
    const unrealized = (Number(row.price_usd) - Number(row.entry_price_usd || row.price_usd)) * Number(row.quantity);
    totalUnrealized += unrealized;
    const changePct = row.entry_price_usd > 0 ? ((row.price_usd - row.entry_price_usd) / row.entry_price_usd) * 100 : 0;
    if (changePct <= -15) await notifyTelegram(env, `🚨 Ciel PAPER emergency exit candidate\nToken: ${row.token_address}\nMove: ${changePct.toFixed(2)}%\nAction: review/sell signal`);
  }
  await writeRuntimeState(env, { lastHoldingCheck: Date.now(), paperUnrealizedPnlUsd: totalUnrealized });
}

async function runMarketCycle(env: Env) {
  const result = await indexNadFun(env);
  await writeRuntimeState(env, { lastMarketCycle: Date.now() });
  if (result.snapshots > 0) await notifyTelegram(env, `📡 Ciel indexer\nSnapshots: ${result.snapshots}\nLatest block: ${result.latestBlock}`);
  await runPaperSignalCycle(env);
}

async function runPaperSignalCycle(env: Env) {
  if (env.PAPER_TRADING !== "true" || env.TRADING_ENABLED === "true") return;
  const rows = await env.DB.prepare("SELECT id FROM signals WHERE consumed_ts_ms IS NULL ORDER BY ts_ms ASC LIMIT 10").all<{ id: number }>();
  for (const row of rows.results || []) {
    await env.TRADING_ENGINE.idFromName(`signal-${row.id}`).toString();
    const stub = env.TRADING_ENGINE.get(env.TRADING_ENGINE.idFromName(`signal-${row.id}`));
    await stub.fetch("https://ciel/paper-signal", { method: "POST", body: JSON.stringify({ action: "paper-signal", signalId: row.id }) });
  }
}

async function runModelMaintenance(env: Env) {
  const snapshots = await env.DB.prepare("SELECT token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,buy_volume_usd,sell_volume_usd FROM market_snapshots ORDER BY ts_ms DESC LIMIT 500").all<Snapshot>();
  const baseline = buildBaseline(snapshots.results || []);
  const analyzed = snapshots.results?.slice(0, 50) || [];
  const signals = [];
  for (const snapshot of analyzed) {
    const score = deviationScore(snapshot, baseline);
    const ai = await askGemini(env, snapshot, score);
    signals.push({ snapshot, score, ai });
  }
  for (const item of signals) {
    const action = item.ai.action === "BUY" || item.ai.action === "SELL" ? item.ai.action : "HOLD";
    await env.DB.prepare("INSERT INTO signals(token_address,ts_ms,action,confidence,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?)").bind(item.snapshot.token_address, item.snapshot.ts_ms, action, item.ai.confidence, item.score, env.GEMINI_MODEL, item.ai.rationale).run();
  }
  await writeRuntimeState(env, { lastModelMaintenance: Date.now(), lastModelAnalyzed: analyzed.length });
  if (signals.length > 0) await notifyTelegram(env, `🧠 Ciel model\nAnalyzed: ${signals.length}\nSignals: ${signals.map(s => `${s.ai.action} ${s.ai.confidence.toFixed(2)}`).join(", ")}`);
}

async function status(env: Env) {
  const state = await readRuntimeState(env);
  const indexerRaw = await env.CIEL_STATE.get("indexer_state");
  let indexerState: { nextBlock?: string; latestBlock?: string; lastSnapshotCount?: number; lastRunMs?: number } = {};
  try { if (indexerRaw) indexerState = JSON.parse(indexerRaw); } catch { /* ignore malformed telemetry */ }
  const balance = await getPaperBalance(env);
  const realized = Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0");
  return {
    ok: true,
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    paperBalanceMon: balance,
    paperRealizedPnlUsd: realized,
    paperCircuitOpen: await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true",
    paperFailureCount: Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0"),
    lastHoldingCheck: state.lastHoldingCheck || null,
    lastMarketCycle: indexerState.lastRunMs ?? null,
    lastModelMaintenance: state.lastModelMaintenance || null,
    lastModelAnalyzed: state.lastModelAnalyzed || null,
    monUsd: state.monUsd || null,
    nextBlock: indexerState.nextBlock || null,
    latestBlock: indexerState.latestBlock || null,
    lastSnapshotCount: indexerState.lastSnapshotCount || 0
  };
}

function json(data: unknown) { return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }); }
