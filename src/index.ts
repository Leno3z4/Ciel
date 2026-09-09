import { indexNadFun } from "./indexer_v2";
import { publicClient, tokenBalance, quoteSell, walletAddress, sellToNative, quoteBuy } from "./nadfun";
import { buildBaseline, deviationScore, buildPatternProfile, askGemini, type Snapshot } from "./model";
import { riskGate } from "./risk";
import { notifyTelegram, testTelegram } from "./telegram";

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
const PATTERN_MIN_HISTORY_SAMPLES = 12;
const PATTERN_MIN_HISTORY_HOURS = 0.5;
const PATTERN_MIN_AVG_VOLUME_5M_USD = 5000;
const PATTERN_MIN_AVG_LIQUIDITY_USD = 10000;
const PATTERN_MIN_MARKET_CAP_USD = 90_000;
const PATTERN_MAX_CANDIDATES = 10;

type PaperState = "CREATED" | "RISK_CHECKED" | "QUOTED" | "BALANCE_RESERVED" | "FILLED" | "POSITION_UPDATED" | "CONSUMED" | "REJECTED" | "FAILED";

type RuntimeState = {
  lastHoldingCheck?: number;
  lastMarketCycle?: number;
  lastModelMaintenance?: number;
  lastModelAnalyzed?: number;
  lastModelError?: string;
  lastMarketCycleError?: string;
  lastIndexerAttempt?: number;
  lastIndexerSnapshots?: number;
  lastIndexerCreates?: number;
  lastIndexerBuys?: number;
  lastIndexerSells?: number;
  lastGeminiAttempt?: number;
  lastGeminiSuccess?: number;
  lastGeminiError?: string;
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
  if (!tables.has("tokens")) statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY,symbol TEXT,name TEXT,market_cap_usd REAL,liquidity_usd REAL,first_seen_ms INTEGER NOT NULL,last_seen_ms INTEGER NOT NULL,total_supply TEXT,decimals INTEGER NOT NULL DEFAULT 18,quote_token TEXT,pair_address TEXT,graduated INTEGER NOT NULL DEFAULT 0,created_at_block INTEGER)`));
  if (!tables.has("market_snapshots")) { statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,token_address TEXT NOT NULL,ts_ms INTEGER NOT NULL,price_usd REAL,market_cap_usd REAL,liquidity_usd REAL,volume_5m_usd REAL,buys_5m INTEGER,sells_5m INTEGER,holders INTEGER,quote_token TEXT,buy_volume_usd REAL,sell_volume_usd REAL,source_block INTEGER)`)); statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_snapshots_token_ts ON market_snapshots(token_address, ts_ms)")); }
  if (!tables.has("signals")) { statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT,token_address TEXT NOT NULL,ts_ms INTEGER NOT NULL,action TEXT NOT NULL,confidence REAL,expected_low REAL,expected_high REAL,anomaly_score REAL,model TEXT,rationale TEXT,consumed_ts_ms INTEGER)`)); statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms)")); }
  if (!tables.has("trades")) { statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT,token_address TEXT NOT NULL,ts_ms INTEGER NOT NULL,side TEXT NOT NULL,quantity TEXT,price_usd REAL,tx_hash TEXT,mode TEXT NOT NULL,status TEXT NOT NULL,error TEXT,execution_key TEXT)`)); statements.push(env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL")); }
  if (!tables.has("positions")) statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS positions (token_address TEXT PRIMARY KEY,quantity TEXT NOT NULL,entry_price_usd REAL,entry_ts_ms INTEGER,last_price_usd REAL,updated_ts_ms INTEGER NOT NULL)`));
  if (!tables.has("paper_executions")) { statements.push(env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_executions (signal_id INTEGER PRIMARY KEY,execution_key TEXT NOT NULL UNIQUE,token_address TEXT NOT NULL,side TEXT NOT NULL,state TEXT NOT NULL,balance_before_mon REAL,balance_after_mon REAL,quantity TEXT,quote_out TEXT,fill_price_usd REAL,realized_pnl_usd REAL,position_quantity_after TEXT,error TEXT,created_ts_ms INTEGER NOT NULL,updated_ts_ms INTEGER NOT NULL)`)); statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_paper_executions_state ON paper_executions(state, updated_ts_ms)")); }
  await env.DB.batch(statements);
  const columns = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('tokens','market_snapshots','signals','trades')").all<{ name: string; sql: string }>();
  const sqlByTable = new Map((columns.results ?? []).map(row => [row.name, row.sql || ""]));
  const addColumn = (table: string, column: string, definition: string) => { const sql = sqlByTable.get(table) || ""; if (!new RegExp(`(?:^|[,(\\s])${column}(?:[\\s,)]|$)`, "i").test(sql)) statements.push(env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)); };
  addColumn("tokens", "total_supply", "TEXT"); addColumn("tokens", "decimals", "INTEGER NOT NULL DEFAULT 18"); addColumn("tokens", "quote_token", "TEXT"); addColumn("tokens", "pair_address", "TEXT"); addColumn("tokens", "graduated", "INTEGER NOT NULL DEFAULT 0"); addColumn("tokens", "created_at_block", "INTEGER"); addColumn("market_snapshots", "quote_token", "TEXT"); addColumn("market_snapshots", "buy_volume_usd", "REAL"); addColumn("market_snapshots", "sell_volume_usd", "REAL"); addColumn("market_snapshots", "source_block", "INTEGER"); addColumn("signals", "consumed_ts_ms", "INTEGER"); addColumn("trades", "execution_key", "TEXT"); statements.push(env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms)")); statements.push(env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL"));
  if (statements.length) await env.DB.batch(statements); await env.CIEL_STATE.put(DB_SCHEMA_VERSION_KEY, DB_SCHEMA_VERSION);
}

async function readRuntimeState(env: Env): Promise<RuntimeState> { const raw = await env.CIEL_STATE.get(RUNTIME_STATE_KEY); if (!raw) return {}; try { return JSON.parse(raw) as RuntimeState; } catch { return {}; } }
async function writeRuntimeState(env: Env, patch: RuntimeState) { if (patch.lastMarketCycle !== undefined) { const { lastMarketCycle: _ignored, ...rest } = patch; patch = rest; } if (Object.keys(patch).length === 0) return; const current = await readRuntimeState(env); const holdingTelemetryOnly = Object.keys(patch).every(key => key === "lastHoldingCheck" || key === "paperUnrealizedPnlUsd"); if (holdingTelemetryOnly) { const lastPersisted = Number(current.lastHoldingCheck || 0); if (lastPersisted > 0 && Date.now() - lastPersisted < RUNTIME_TELEMETRY_INTERVAL_MS) return; } await env.CIEL_STATE.put(RUNTIME_STATE_KEY, JSON.stringify({ ...current, ...patch })); }

export interface Env { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA: R2Bucket; TRADING_ENGINE: DurableObjectNamespace; GEMINI_API_KEY_1?: string; GEMINI_API_KEY_2?: string; WALLET_PRIVATE_KEY?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; TRADING_ENABLED: string; PAPER_TRADING: string; HOLDING_CHECK_MINUTES: string; GEMINI_MODEL: string; NAD_RPC_URL?: string; }

export default { async fetch(request: Request, env: Env): Promise<Response> { const url = new URL(request.url); if (url.pathname === "/health") return json({ ok: true, service: "ciel", tradingEnabled: env.TRADING_ENABLED === "true", paperTrading: env.PAPER_TRADING === "true" }); if (url.pathname === "/status") { if (url.searchParams.get("telegramTest") === "1") return json(await testTelegram(env)); return json(await status(env)); } return new Response("Ciel trading service", { status: 200 }); }, async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) { if (controller.cron === "*/2 * * * *") ctx.waitUntil(runHoldingCheck(env)); if (controller.cron === "*/3 * * * *") ctx.waitUntil(runMarketCycle(env)); if (controller.cron === "0 * * * *") ctx.waitUntil(runModelMaintenance(env)); } };

export class TradingEngine { constructor(private state: DurableObjectState, private env: Env) {} async fetch(request: Request): Promise<Response> { if (request.method !== "POST") return new Response("Method not allowed", { status: 405 }); const body = await request.json().catch(() => ({})) as { action?: string; signalId?: number }; if (body.action === "paper-signal" && Number.isInteger(body.signalId)) return json(await executePaperSignal(this.env, body.signalId!)); await this.state.storage.put("lastEvent", { at: Date.now(), body }); return json({ ok: true }); } }

function positiveQuantitySql(column: string) { return `${column} <> '0'`; }

async function runHoldingCheck(env: Env) { const checkedAt = Date.now(); try { await ensureDatabaseSchema(env); const state = await readRuntimeState(env); const monUsd = Number(state.monUsd || await env.CIEL_STATE.get("mon_usd")); if (!(monUsd > 0)) { await writeRuntimeState(env, { lastHoldingCheck: checkedAt }); return; } if (env.PAPER_TRADING === "true" && env.TRADING_ENABLED !== "true") await runPaperPositionMonitoring(env, monUsd); const address = walletAddress(env.WALLET_PRIVATE_KEY); if (!address) { await writeRuntimeState(env, { lastHoldingCheck: checkedAt }); return; } const native = await publicClient(env.NAD_RPC_URL).getBalance({ address }); if (native === 0n) { await writeRuntimeState(env, { lastHoldingCheck: checkedAt }); return; } const tokens = await env.DB.prepare("SELECT address,decimals FROM tokens WHERE graduated=1").all<{ address: string; decimals: number }>(); for (const row of tokens.results || []) { const balance = await tokenBalance(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, address); if (balance > 0n) { const quote = await quoteSell(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, balance); if (quote > 0n) { const valueUsd = Number(quote) / 1e18 * monUsd; if (valueUsd > 0) await writeRuntimeState(env, { lastHoldingCheck: checkedAt, paperUnrealizedPnlUsd: undefined }); } } } await writeRuntimeState(env, { lastHoldingCheck: checkedAt }); } catch (error) { await writeRuntimeState(env, { lastHoldingCheck: checkedAt }); console.error(`Holding check failed: ${String(error).slice(0, 1000)}`); } }

async function runPaperPositionMonitoring(env: Env, monUsd: number) { const rows = await env.DB.prepare(`SELECT p.token_address,p.quantity,p.entry_price_usd,s.price_usd FROM positions p LEFT JOIN market_snapshots s ON s.token_address=p.token_address WHERE ${positiveQuantitySql("p.quantity")} AND s.ts_ms=(SELECT MAX(s2.ts_ms) FROM market_snapshots s2 WHERE s2.token_address=p.token_address)`).all<{ token_address: string; quantity: string; entry_price_usd: number; price_usd: number }>(); let totalUnrealized = 0; for (const row of rows.results || []) { const unrealized = (Number(row.price_usd) - Number(row.entry_price_usd || row.price_usd)) * Number(row.quantity); totalUnrealized += unrealized; const changePct = row.entry_price_usd > 0 ? ((row.price_usd - row.entry_price_usd) / row.entry_price_usd) * 100 : 0; if (changePct <= -15) await notifyTelegram(env, `🚨 Ciel PAPER emergency exit candidate\nToken: ${row.token_address}\nMove: ${changePct.toFixed(2)}%\nAction: review/sell signal`); } await writeRuntimeState(env, { lastHoldingCheck: Date.now(), paperUnrealizedPnlUsd: totalUnrealized }); }

async function runMarketCycle(env: Env) { const cycleAt = Date.now(); try { await ensureDatabaseSchema(env); await writeRuntimeState(env, { lastIndexerAttempt: cycleAt }); const result = await indexNadFun(env); await writeRuntimeState(env, { lastMarketCycle: cycleAt, lastMarketCycleError: undefined, lastIndexerSnapshots: result?.snapshots || 0, lastIndexerCreates: result?.creates || 0, lastIndexerBuys: result?.buys || 0, lastIndexerSells: result?.sells || 0 }); if (result && (result.snapshots > 0 || result.buys > 0 || result.sells > 0)) await notifyTelegram(env, `📡 Ciel indexer\nBlocks: ${result.fromBlock.toString()} - ${result.toBlock.toString()}\nCreates: ${result.creates}\nBuys: ${result.buys}\nSells: ${result.sells}\nSnapshots: ${result.snapshots}`); await runPaperSignalCycle(env); } catch (error) { const message = String(error).slice(0, 1000); await writeRuntimeState(env, { lastMarketCycle: cycleAt, lastMarketCycleError: message }); console.error(`Market cycle failed: ${message}`); } }

async function runPaperSignalCycle(env: Env) { if (env.TRADING_ENABLED === "true" || env.PAPER_TRADING !== "true") return; if (await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true") return; const rows = await env.DB.prepare("SELECT id FROM signals WHERE consumed_ts_ms IS NULL ORDER BY ts_ms ASC LIMIT 10").all<{ id: number }>(); for (const row of rows.results || []) await executePaperSignal(env, row.id); }

async function selectPatternCandidates(env: Env): Promise<Array<{ token: string; samples: number; firstTs: number; lastTs: number; avgVolume: number; avgLiquidity: number; avgMarketCap: number }>> {
  const rows = await env.DB.prepare(`SELECT token_address as token,
       COUNT(*) as samples,
       MIN(ts_ms) as firstTs,
       MAX(ts_ms) as lastTs,
       AVG(volume_5m_usd) as avgVolume,
       AVG(liquidity_usd) as avgLiquidity,
       AVG(market_cap_usd) as avgMarketCap
    FROM market_snapshots
    WHERE price_usd>0
    GROUP BY token_address
    HAVING COUNT(*)>=?
       AND (MAX(ts_ms)-MIN(ts_ms))>=?
       AND AVG(volume_5m_usd)>=?
       AND AVG(liquidity_usd)>=?
       AND AVG(market_cap_usd)>=?
    ORDER BY AVG(volume_5m_usd) DESC
    LIMIT ?`).bind(
    PATTERN_MIN_HISTORY_SAMPLES,
    PATTERN_MIN_HISTORY_HOURS * 3600000,
    PATTERN_MIN_AVG_VOLUME_5M_USD,
    PATTERN_MIN_AVG_LIQUIDITY_USD,
    PATTERN_MIN_MARKET_CAP_USD,
    PATTERN_MAX_CANDIDATES
  ).all<{ token: string; samples: number; firstTs: number; lastTs: number; avgVolume: number; avgLiquidity: number; avgMarketCap: number }>();
  return rows.results || [];
}

async function maybeWriteModelSignal(env: Env, current: Snapshot, analysis: Awaited<ReturnType<typeof askGemini>>) {
  if (!analysis || !["BUY", "HOLD", "SELL", "IGNORE"].includes(analysis.action)) return;
  await env.DB.prepare(`INSERT INTO signals(token_address,ts_ms,action,confidence,expected_low,expected_high,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?,?,?)`).bind(current.token, Date.now(), analysis.action, analysis.confidence, analysis.expectedLowUsd, analysis.expectedHighUsd, analysis.anomalyScore, env.GEMINI_MODEL, analysis.rationale).run();
}

async function runModelMaintenance(env: Env) {
  const now = Date.now();
  try {
    await ensureDatabaseSchema(env);
    await writeRuntimeState(env, { lastModelMaintenance: now });
    const candidates = await selectPatternCandidates(env);
    if (!candidates.length) {
      await writeRuntimeState(env, { lastModelError: "No established high-volume meme candidates above $90,000 yet" });
      return;
    }
    const apiKeys = [env.GEMINI_API_KEY_1, env.GEMINI_API_KEY_2].filter((key): key is string => !!key && key.trim().length > 0);
    if (!apiKeys.length) throw new Error("No Gemini API keys configured");
    let keyIndex = 0;
    for (const candidate of candidates) {
      const rows = await env.DB.prepare(`SELECT token_address as token,ts_ms as tsMs,price_usd as priceUsd,market_cap_usd as marketCapUsd,liquidity_usd as liquidityUsd,volume_5m_usd as volume5mUsd,buys_5m as buys5m,sells_5m as sells5m,holders FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1440`).bind(candidate.token).all<Snapshot>();
      const history = rows.results || [];
      if (!history.length) continue;
      const baseline = buildBaseline(history);
      const current = history[0];
      const pattern = buildPatternProfile(history);
      const score = deviationScore(current, baseline);
      await writeRuntimeState(env, { lastGeminiAttempt: Date.now() });
      const analysis = await askGemini(apiKeys[keyIndex % apiKeys.length], env.GEMINI_MODEL, "market", current, baseline, score, pattern);
      keyIndex++;
      if (analysis) {
        await maybeWriteModelSignal(env, current, analysis);
        await writeRuntimeState(env, { lastModelAnalyzed: Date.now(), lastGeminiSuccess: Date.now(), lastGeminiError: undefined, lastModelError: undefined });
      }
    }
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await writeRuntimeState(env, { lastModelError: message, lastGeminiError: message });
    console.error(`Model maintenance failed: ${message}`);
  }
}

async function executePaperSignal(env: Env, signalId: number) {
  const signal = await env.DB.prepare("SELECT * FROM signals WHERE id=?").bind(signalId).first<Record<string, unknown>>();
  if (!signal) return { ok: false, error: "signal_not_found" };
  const action = String(signal.action || "");
  if (action !== "BUY" && action !== "SELL") { await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=?").bind(Date.now(), signalId).run(); return { ok: true, skipped: true }; }
  const token = String(signal.token_address);
  const current = await env.DB.prepare("SELECT market_cap_usd,price_usd FROM market_snapshots WHERE token_address=? ORDER BY ts_ms DESC LIMIT 1").bind(token).first<{ market_cap_usd: number; price_usd: number }>();
  if (!current || !(current.price_usd > 0)) { await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=?").bind(Date.now(), signalId).run(); return { ok: false, error: "no_current_market" }; }
  const balanceRaw = await env.CIEL_STATE.get(PAPER_BALANCE_KEY); const balance = balanceRaw ? Number(balanceRaw) : PAPER_INITIAL_BALANCE_MON;
  if (action === "BUY") {
    if (!(balance > 0)) { await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=?").bind(Date.now(), signalId).run(); return { ok: false, error: "paper_balance_empty" }; }
    const nextBalance = 0;
    await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(nextBalance));
    const quantity = balance * (1 - PAPER_SLIPPAGE_BPS / 10000) / current.price_usd;
    await env.DB.prepare(`INSERT INTO positions(token_address,quantity,entry_price_usd,entry_ts_ms,last_price_usd,updated_ts_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET quantity=positions.quantity+excluded.quantity,last_price_usd=excluded.last_price_usd,updated_ts_ms=excluded.updated_ts_ms`).bind(token, String(quantity), current.price_usd, Date.now(), current.price_usd, Date.now()).run();
    await env.DB.prepare(`INSERT INTO paper_executions(signal_id,execution_key,token_address,side,state,balance_before_mon,balance_after_mon,quantity,fill_price_usd,error,created_ts_ms,updated_ts_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(signal_id) DO NOTHING`).bind(signalId, `paper:${signalId}`, token, "BUY", "CONSUMED", balance, nextBalance, String(quantity), current.price_usd, null, Date.now(), Date.now()).run();
  } else {
    const position = await env.DB.prepare("SELECT quantity,entry_price_usd FROM positions WHERE token_address=?").bind(token).first<{ quantity: string; entry_price_usd: number }>();
    if (!position || !(Number(position.quantity) > 0)) { await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=?").bind(Date.now(), signalId).run(); return { ok: false, error: "paper_position_missing" }; }
    const proceeds = Number(position.quantity) * current.price_usd * (1 - PAPER_SLIPPAGE_BPS / 10000);
    const nextBalance = balance + proceeds;
    const realized = (current.price_usd - Number(position.entry_price_usd || current.price_usd)) * Number(position.quantity);
    await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(nextBalance));
    await env.CIEL_STATE.put(PAPER_REALIZED_PNL_KEY, String(Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || 0) + realized));
    await env.DB.prepare("DELETE FROM positions WHERE token_address=?").bind(token).run();
    await env.DB.prepare(`INSERT INTO paper_executions(signal_id,execution_key,token_address,side,state,balance_before_mon,balance_after_mon,quantity,fill_price_usd,realized_pnl_usd,error,created_ts_ms,updated_ts_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?) ON CONFLICT(signal_id) DO NOTHING`).bind(signalId, `paper:${signalId}`, token, "SELL", "CONSUMED", balance, nextBalance, position.quantity, current.price_usd, realized, null, Date.now(), Date.now()).run();
  }
  await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=?").bind(Date.now(), signalId).run();
  return { ok: true, action, token };
}

async function status(env: Env) {
  const runtime = await readRuntimeState(env);
  return {
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    telegramLastAttemptAt: runtime.lastTelegramAttemptAt,
    telegramLastSuccessAt: runtime.lastTelegramSuccessAt,
    telegramLastFailureAt: runtime.lastTelegramFailureAt,
    telegramLastError: runtime.lastTelegramError,
    telegramLastTestAt: runtime.lastTelegramTestAt,
    telegramLastTestSuccess: runtime.lastTelegramTestSuccess,
    paperBalanceMon: Number(await env.CIEL_STATE.get(PAPER_BALANCE_KEY) || PAPER_INITIAL_BALANCE_MON),
    paperRealizedPnlUsd: Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || 0),
    paperFailureCount: Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || 0),
    paperCircuitOpen: (await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY)) === "true",
    lastHoldingCheck: runtime.lastHoldingCheck,
    lastMarketCycle: runtime.lastMarketCycle,
    lastMarketCycleError: runtime.lastMarketCycleError,
    lastModelMaintenance: runtime.lastModelMaintenance,
    lastModelAnalyzed: runtime.lastModelAnalyzed,
    lastModelError: runtime.lastModelError,
    lastIndexerAttempt: runtime.lastIndexerAttempt,
    lastIndexerSnapshots: runtime.lastIndexerSnapshots,
    lastIndexerCreates: runtime.lastIndexerCreates,
    lastIndexerBuys: runtime.lastIndexerBuys,
    lastIndexerSells: runtime.lastIndexerSells,
    lastGeminiAttempt: runtime.lastGeminiAttempt,
    lastGeminiSuccess: runtime.lastGeminiSuccess,
    lastGeminiError: runtime.lastGeminiError,
    paperUnrealizedPnlUsd: runtime.paperUnrealizedPnlUsd,
  };
}

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
