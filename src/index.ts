import { indexNadFun } from "./indexer";
import { publicClient, tokenBalance, quoteSell, quoteBuy, walletAddress, sellToNative } from "./nadfun";
import { buildBaseline, deviationScore, askGemini, type Snapshot } from "./model";
import { riskGate } from "./risk";
import { notifyTelegram } from "./telegram";

const PAPER_INITIAL_BALANCE_MON = 1000;
const PAPER_SLIPPAGE_BPS = 500;
const PAPER_BALANCE_KEY = "paper_balance_mon";
const PAPER_REALIZED_PNL_KEY = "paper_realized_pnl_usd";
const PAPER_FAILURE_COUNT_KEY = "paper_execution_failure_count";
const PAPER_CIRCUIT_KEY = "paper_execution_circuit_open";
const RUNTIME_STATE_KEY = "ciel_runtime_state";
const DB_SCHEMA_VERSION_KEY = "ciel_db_schema_version";
const DB_SCHEMA_VERSION = "3";
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

async function ensureDatabaseSchema(env: Env): Promise<void> {
  if (await env.CIEL_STATE.get(DB_SCHEMA_VERSION_KEY) === DB_SCHEMA_VERSION) return;

  const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  const tables = new Set((existing.results ?? []).map(row => row.name));
  const statements: D1PreparedStatement[] = [];

  if (!tables.has("tokens")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      market_cap_usd REAL,
      liquidity_usd REAL,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      total_supply TEXT,
      decimals INTEGER NOT NULL DEFAULT 18,
      quote_token TEXT,
      pair_address TEXT,
      graduated INTEGER NOT NULL DEFAULT 0,
      created_at_block INTEGER
    )`));
  }
  if (!tables.has("market_snapshots")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      price_usd REAL,
      market_cap_usd REAL,
      liquidity_usd REAL,
      volume_5m_usd REAL,
      buys_5m INTEGER,
      sells_5m INTEGER,
      holders INTEGER,
      quote_token TEXT,
      buy_volume_usd REAL,
      sell_volume_usd REAL,
      source_block INTEGER
    )`));
    statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_snapshots_token_ts ON market_snapshots(token_address, ts_ms)"));
  }
  if (!tables.has("signals")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      confidence REAL,
      expected_low REAL,
      expected_high REAL,
      anomaly_score REAL,
      model TEXT,
      rationale TEXT,
      consumed_ts_ms INTEGER
    )`));
    statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms)"));
  }
  if (!tables.has("trades")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      quantity TEXT,
      price_usd REAL,
      tx_hash TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      execution_key TEXT
    )`));
    statements.push(env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL"));
  }
  if (!tables.has("positions")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS positions (
      token_address TEXT PRIMARY KEY,
      quantity TEXT NOT NULL,
      entry_price_usd REAL,
      entry_ts_ms INTEGER,
      last_price_usd REAL,
      updated_ts_ms INTEGER NOT NULL
    )`));
  }
  if (!tables.has("paper_executions")) {
    statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_executions (
      signal_id INTEGER PRIMARY KEY,
      execution_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL,
      state TEXT NOT NULL,
      balance_before_mon REAL,
      balance_after_mon REAL,
      quantity TEXT,
      quote_out TEXT,
      fill_price_usd REAL,
      realized_pnl_usd REAL,
      position_quantity_after TEXT,
      error TEXT,
      created_ts_ms INTEGER NOT NULL,
      updated_ts_ms INTEGER NOT NULL
    )`));
    statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_paper_executions_state ON paper_executions(state, updated_ts_ms)"));
  }

  await env.DB.batch(statements);

  const columns = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('tokens','market_snapshots','signals','trades')").all<{ name: string; sql: string }>();
  const sqlByTable = new Map((columns.results ?? []).map(row => [row.name, row.sql || ""]));
  const addColumn = (table: string, column: string, definition: string) => {
    const sql = sqlByTable.get(table) || "";
    if (!new RegExp(`(?:^|[,(\\s])${column}(?:[\\s,)]|$)`, "i").test(sql)) statements.push(env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  };

  addColumn("tokens", "total_supply", "TEXT");
  addColumn("tokens", "decimals", "INTEGER NOT NULL DEFAULT 18");
  addColumn("tokens", "quote_token", "TEXT");
  addColumn("tokens", "pair_address", "TEXT");
  addColumn("tokens", "graduated", "INTEGER NOT NULL DEFAULT 0");
  addColumn("tokens", "created_at_block", "INTEGER");
  addColumn("market_snapshots", "quote_token", "TEXT");
  addColumn("market_snapshots", "buy_volume_usd", "REAL");
  addColumn("market_snapshots", "sell_volume_usd", "REAL");
  addColumn("market_snapshots", "source_block", "INTEGER");
  addColumn("signals", "consumed_ts_ms", "INTEGER");
  addColumn("trades", "execution_key", "TEXT");
  statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms)"));
  statements.push(env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL"));

  if (statements.length) await env.DB.batch(statements);
  await env.CIEL_STATE.put(DB_SCHEMA_VERSION_KEY, DB_SCHEMA_VERSION);
}

async function readRuntimeState(env: Env): Promise<RuntimeState> {
  const raw = await env.CIEL_STATE.get(RUNTIME_STATE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as RuntimeState; } catch { return {}; }
}

async function writeRuntimeState(env: Env, patch: RuntimeState) {
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
      const amountMon = balance;
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
      const failureCount = Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0");
      const circuitOpen = await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true";
      if (failureCount > 0 || circuitOpen) {
        await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, "0");
        await env.CIEL_STATE.delete(PAPER_CIRCUIT_KEY);
        await writeRuntimeState(env, { paperFailureCount: 0, paperCircuitOpen: false });
      }
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
      await setPaperState(env, signalId, "QUOTED", { balance_before_mon: balance, balance_after_mon: expectedAfter, quote_out: quoteOut.toString(), fill_price_usd: fillPriceUsd, realized_pnl_usd: pnlUsd, position_quantity_after: "0" });
      const currentBalance = await getPaperBalance(env);
      if (Math.abs(currentBalance - balance) > 1e-9) throw new Error("paper balance changed unexpectedly during SELL reservation");
      await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(expectedAfter));
      await env.CIEL_STATE.put(PAPER_REALIZED_PNL_KEY, String(Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0") + pnlUsd));
      await setPaperState(env, signalId, "BALANCE_RESERVED", {});
      await env.DB.prepare("INSERT OR IGNORE INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error,execution_key) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(token, Date.now(), "SELL", quantity.toString(), fillPriceUsd, null, "paper", "filled", null, execution.key).run();
      await setPaperState(env, signalId, "FILLED", {});
      await env.DB.prepare("UPDATE positions SET quantity='0',last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(fillPriceUsd, Date.now(), token).run();
      await setPaperState(env, signalId, "POSITION_UPDATED", {});
      await markConsumed(env, signalId);
      await setPaperState(env, signalId, "CONSUMED", {});
      const failureCount = Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0");
      const circuitOpen = await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true";
      if (failureCount > 0 || circuitOpen) {
        await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, "0");
        await env.CIEL_STATE.delete(PAPER_CIRCUIT_KEY);
        await writeRuntimeState(env, { paperFailureCount: 0, paperCircuitOpen: false });
      }
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
  await ensureDatabaseSchema(env);
  const result = await indexNadFun(env);
  await writeRuntimeState(env, { lastMarketCycle: Date.now() });
  if (result.snapshots > 0) await notifyTelegram(env, `📡 Ciel indexer\nSnapshots: ${result.snapshots}\nTokens: ${result.tokens}`);
  await runPaperSignalCycle(env);
}

async function runPaperSignalCycle(env: Env) {
  if (env.TRADING_ENABLED === "true" || env.PAPER_TRADING !== "true") return;
  if (await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true") return;
  const rows = await env.DB.prepare("SELECT id FROM signals WHERE consumed_ts_ms IS NULL ORDER BY ts_ms ASC LIMIT 10").all<{ id: number }>();
  for (const row of rows.results || []) {
    await executePaperSignal(env, row.id);
  }
}

async function runModelMaintenance(env: Env) {
  await ensureDatabaseSchema(env);
  const result = await env.DB.prepare("SELECT * FROM signals ORDER BY ts_ms DESC LIMIT 50").all();
  const rows = (result.results || []) as unknown as Snapshot[];
  const baseline = buildBaseline(rows);
  const last = rows[0];
  if (last) deviationScore(last, baseline);
  await writeRuntimeState(env, { lastModelMaintenance: Date.now() });
  const analysis = await askGemini(env, rows);
  if (analysis) {
    await writeRuntimeState(env, { lastModelAnalyzed: Date.now() });
    await notifyTelegram(env, `🧠 Ciel model\n${analysis.slice(0, 3000)}`);
  }
}

async function status(env: Env) {
  const indexerRaw = await env.CIEL_STATE.get("indexer_state");
  let indexerState: { lastRunMs?: number } = {};
  try { if (indexerRaw) indexerState = JSON.parse(indexerRaw); } catch {}
  const state = await readRuntimeState(env);
  return {
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    paperBalanceMon: await getPaperBalance(env),
    paperRealizedPnlUsd: Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0"),
    paperFailureCount: Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0"),
    paperCircuitOpen: await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true",
    lastHoldingCheck: state.lastHoldingCheck || null,
    lastMarketCycle: indexerState.lastRunMs || null,
    lastModelMaintenance: state.lastModelMaintenance || null,
    lastModelAnalyzed: state.lastModelAnalyzed || null
  };
}

function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }