import { indexNadFun } from "./indexer";
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
  if (!analysis || !["BUY", "SELL"].includes(analysis.action)) return;
  const existingPosition = await env.DB.prepare("SELECT quantity FROM positions WHERE token_address=? AND quantity<>'0'").bind(current.token).first<{ quantity: string }>();
  if (analysis.action === "BUY" && existingPosition) return;
  if (analysis.action === "SELL" && !existingPosition) return;
  const recent = await env.DB.prepare("SELECT id FROM signals WHERE token_address=? AND action=? AND ts_ms>? ORDER BY ts_ms DESC LIMIT 1").bind(current.token, analysis.action, Date.now() - 3600000).first<{ id: number }>();
  if (recent) return;
  await env.DB.prepare(`INSERT INTO signals(token_address,ts_ms,action,confidence,expected_low,expected_high,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    current.token, Date.now(), analysis.action, analysis.confidence, analysis.expectedLowUsd, analysis.expectedHighUsd, analysis.anomalyScore, "gemini-established-pattern", `${analysis.regime}: ${analysis.rationale}`
  ).run();
}

async function runModelMaintenance(env: Env) { const maintenanceAt = Date.now(); try {
  await ensureDatabaseSchema(env);
  const candidates = await selectPatternCandidates(env);
  if (!candidates.length) { await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: `No established high-volume meme candidates above $${PATTERN_MIN_MARKET_CAP_USD.toLocaleString()} yet` }); return; }
  const apiKey = env.GEMINI_API_KEY_1 || env.GEMINI_API_KEY_2;
  await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastGeminiAttempt: Date.now(), lastModelError: undefined });
  if (!apiKey) { await writeRuntimeState(env, { lastGeminiError: "No Gemini API key configured" }); return; }

  let analyzed = 0;
  const decisions: string[] = [];
  for (const candidate of candidates) {
    const historyResult = await env.DB.prepare(`SELECT token_address as token,ts_ms as tsMs,price_usd as priceUsd,market_cap_usd as marketCapUsd,liquidity_usd as liquidityUsd,volume_5m_usd as volume5mUsd,buys_5m as buys5m,sells_5m as sells5m,holders
      FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 50`).bind(candidate.token).all<Snapshot>();
    const history = historyResult.results || [];
    if (history.length < PATTERN_MIN_HISTORY_SAMPLES) continue;
    const current = history[0];
    if (!(Number(current.marketCapUsd) >= PATTERN_MIN_MARKET_CAP_USD)) continue;
    const baseline = buildBaseline(history);
    const score = deviationScore(current, baseline);
    const pattern = buildPatternProfile(history);
    const analysis = await askGemini(apiKey, env.GEMINI_MODEL, "market", current, baseline, score, pattern);
    if (!analysis) continue;
    analyzed++;
    await maybeWriteModelSignal(env, current, analysis);
    decisions.push(`${current.token}:${analysis.action}:${(analysis.confidence * 100).toFixed(0)}%:${analysis.regime}`);
  }

  if (analyzed > 0) {
    await writeRuntimeState(env, { lastGeminiSuccess: Date.now(), lastGeminiError: undefined, lastModelAnalyzed: Date.now(), lastModelError: undefined });
    await notifyTelegram(env, `🧠 Ciel established-pattern scan\nMarket-cap floor: $${PATTERN_MIN_MARKET_CAP_USD.toLocaleString()}\nCandidates: ${candidates.length}\nAnalyzed: ${analyzed}\n${decisions.slice(0, 10).join("\n")}`.slice(0, 3900));
  } else {
    await writeRuntimeState(env, { lastGeminiError: `Established candidates above $${PATTERN_MIN_MARKET_CAP_USD.toLocaleString()} were found but none produced a valid Gemini decision` });
  }
} catch (error) { const message = String(error).slice(0, 1000); await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: message }); console.error(`Model maintenance failed: ${message}`); } }

async function status(env: Env) { const indexerRaw = await env.CIEL_STATE.get("indexer_state"); let indexerState: { lastRunMs?: number } = {}; try { if (indexerRaw) indexerState = JSON.parse(indexerRaw); } catch {} const telegramRaw = await env.CIEL_STATE.get("ciel_telegram_runtime"); let telegramState: { lastAttemptAt?: number; lastSuccessAt?: number; lastFailureAt?: number; lastTestAt?: number; lastTestSuccess?: boolean; lastError?: string } = {}; try { if (telegramRaw) telegramState = JSON.parse(telegramRaw); } catch {} const state = await readRuntimeState(env); return { tradingEnabled: env.TRADING_ENABLED === "true", paperTrading: env.PAPER_TRADING === "true", telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), telegramLastAttemptAt: telegramState.lastAttemptAt || null, telegramLastSuccessAt: telegramState.lastSuccessAt || null, telegramLastFailureAt: telegramState.lastFailureAt || null, telegramLastError: telegramState.lastError || null, telegramLastTestAt: telegramState.lastTestAt || null, telegramLastTestSuccess: telegramState.lastTestSuccess ?? null, paperBalanceMon: await getPaperBalance(env), paperRealizedPnlUsd: Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0"), paperFailureCount: Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0"), paperCircuitOpen: await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true", lastHoldingCheck: state.lastHoldingCheck || null, lastMarketCycle: state.lastMarketCycle || indexerState.lastRunMs || null, lastMarketCycleError: state.lastMarketCycleError || null, lastModelMaintenance: state.lastModelMaintenance || null, lastModelAnalyzed: state.lastModelAnalyzed || null, lastModelError: state.lastModelError || null, lastIndexerAttempt: state.lastIndexerAttempt || null, lastIndexerSnapshots: state.lastIndexerSnapshots ?? null, lastIndexerCreates: state.lastIndexerCreates ?? null, lastIndexerBuys: state.lastIndexerBuys ?? null, lastIndexerSells: state.lastIndexerSells ?? null, lastGeminiAttempt: state.lastGeminiAttempt || null, lastGeminiSuccess: state.lastGeminiSuccess || null, lastGeminiError: state.lastGeminiError || null }; }

function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }

async function getPaperBalance(env: Env): Promise<number> { const raw = await env.CIEL_STATE.get(PAPER_BALANCE_KEY); if (raw === null) { await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(PAPER_INITIAL_BALANCE_MON)); return PAPER_INITIAL_BALANCE_MON; } const value = Number(raw); return Number.isFinite(value) ? value : PAPER_INITIAL_BALANCE_MON; }

async function consumeSignal(env: Env, signalId: number, reason: string) { await env.DB.prepare("UPDATE signals SET consumed_ts_ms=? WHERE id=? AND consumed_ts_ms IS NULL").bind(Date.now(), signalId).run(); return { ok: true, skipped: reason }; }

async function beginPaperExecution(env: Env, signal: { id: number; token_address: string; action: string }) { const key = `paper:${signal.id}`; const now = Date.now(); await env.DB.prepare(`INSERT INTO paper_executions(signal_id,execution_key,token_address,side,state,created_ts_ms,updated_ts_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(signal_id) DO NOTHING`).bind(signal.id, key, signal.token_address, signal.action, "CREATED", now, now).run(); return { key, row: await env.DB.prepare("SELECT * FROM paper_executions WHERE signal_id=?").bind(signal.id).first<any>() }; }

async function setPaperState(env: Env, signalId: number, state: PaperState, fields: Record<string, unknown> = {}) { const keys = Object.keys(fields); const sets = ["state=?", "updated_ts_ms=?", ...keys.map(k => `${k}=?`)]; const values = [state, Date.now(), ...keys.map(k => fields[k])]; await env.DB.prepare(`UPDATE paper_executions SET ${sets.join(",")} WHERE signal_id=?`).bind(...values, signalId).run(); }

async function failPaperExecution(env: Env, signalId: number, error: unknown) { const message = String(error).slice(0, 1000); await setPaperState(env, signalId, "FAILED", { error: message }); const raw = Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0"); const count = Number.isFinite(raw) ? raw + 1 : 1; await env.CIEL_STATE.put(PAPER_FAILURE_COUNT_KEY, String(count)); if (count >= 3) await env.CIEL_STATE.put(PAPER_CIRCUIT_KEY, "true"); await writeRuntimeState(env, { paperFailureCount: count, paperCircuitOpen: count >= 3 }); }

async function executePaperSignal(env: Env, signalId: number) { if (env.TRADING_ENABLED === "true") return { ok: false, skipped: "live trading flag is enabled; paper executor is disabled" }; if (env.PAPER_TRADING !== "true") return { ok: false, skipped: "paper trading disabled" }; if (await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true") return { ok: false, skipped: "paper execution circuit breaker is open" }; const signal = await env.DB.prepare("SELECT id,token_address,action,confidence,consumed_ts_ms FROM signals WHERE id=?").bind(signalId).first<{ id: number; token_address: string; action: string; confidence: number; consumed_ts_ms: number | null }>(); if (!signal) return { ok: false, skipped: "signal missing" }; const execution = await beginPaperExecution(env, signal); const existing = execution.row; if (existing?.state === "CONSUMED") return { ok: true, skipped: "paper execution already consumed", executionState: existing.state }; if (existing?.state === "REJECTED") return { ok: false, skipped: existing.error || "paper execution rejected" }; if (signal.consumed_ts_ms !== null && existing?.state === "CREATED") { await setPaperState(env, signalId, "REJECTED", { error: "signal was already consumed" }); return { ok: false, skipped: "signal was already consumed" }; } const token = signal.token_address as `0x${string}`; const state = await readRuntimeState(env); const monUsd = Number(state.monUsd || await env.CIEL_STATE.get("mon_usd")); const meta = await env.DB.prepare("SELECT decimals,liquidity_usd FROM tokens WHERE address=?").bind(token).first<{ decimals: number; liquidity_usd: number }>(); const current = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1").bind(token).first<{ price_usd: number }>(); const previous = await env.DB.prepare("SELECT price_usd FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 1 OFFSET 1").bind(token).first<{ price_usd: number }>(); const liquidityUsd = Number(meta?.liquidity_usd || 0); const priceChangePct = previous?.price_usd && current?.price_usd ? ((current.price_usd - previous.price_usd) / previous.price_usd) * 100 : 0; const client = publicClient(env.NAD_RPC_URL); try { if (signal.action === "BUY") { const balance = await getPaperBalance(env); const amountMon = balance; if (!(amountMon > 0) || !(monUsd > 0)) return consumeSignal(env, signalId, "paper skipped: insufficient balance or MON/USD price"); const amountIn = BigInt(Math.floor(amountMon * 1e18)); const tokenOut = await quoteBuy(client, token, amountIn); if (tokenOut <= 0n) return consumeSignal(env, signalId, "paper skipped: fresh buy quote returned zero"); const decimals = Number(meta?.decimals || 18); const position = await env.DB.prepare("SELECT quantity,entry_price_usd FROM positions WHERE token_address=?").bind(token).first<{ quantity: string; entry_price_usd: number }>(); const existingQty = BigInt(position?.quantity || "0"); const quantity = existingQty + tokenOut; const fillPriceUsd = monUsd * amountMon / (Number(tokenOut) / 10 ** decimals); await setPaperState(env, signalId, "RISK_CHECKED", { balance_before_mon: balance, quantity: tokenOut.toString(), fill_price_usd: fillPriceUsd }); if (!(await riskGate({ action: "BUY", confidence: Number(signal.confidence || 0), liquidityUsd, priceChangePct, monUsd }))) return consumeSignal(env, signalId, "paper skipped: risk gate rejected BUY"); await setPaperState(env, signalId, "QUOTED", { quote_out: tokenOut.toString() }); await env.CIEL_STATE.put(PAPER_BALANCE_KEY, "0"); await setPaperState(env, signalId, "BALANCE_RESERVED", { balance_after_mon: 0 }); const now = Date.now(); const entryPrice = existingQty > 0n && position?.entry_price_usd ? ((Number(existingQty) * Number(position.entry_price_usd)) + Number(tokenOut) * fillPriceUsd) / Number(quantity) : fillPriceUsd; await env.DB.prepare(`INSERT INTO positions(token_address,quantity,entry_price_usd,entry_ts_ms,last_price_usd,updated_ts_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET quantity=excluded.quantity,entry_price_usd=excluded.entry_price_usd,last_price_usd=excluded.last_price_usd,updated_ts_ms=excluded.updated_ts_ms`).bind(token, quantity.toString(), entryPrice, fillPriceUsd, now, now).run(); await env.DB.prepare(`INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,mode,status,execution_key) VALUES(?,?,?,?,?,?,?,?)`).bind(token, now, "BUY", tokenOut.toString(), fillPriceUsd, "paper", "FILLED", `paper:${signal.id}`).run(); await setPaperState(env, signalId, "FILLED", { position_quantity_after: quantity.toString() }); await setPaperState(env, signalId, "POSITION_UPDATED"); await consumeSignal(env, signalId, "paper BUY filled"); await setPaperState(env, signalId, "CONSUMED"); await notifyTelegram(env, `📝 Ciel PAPER BUY\nToken: ${token}\nConfidence: ${Number(signal.confidence || 0) * 100}%\nFill: $${fillPriceUsd}`); return { ok: true, action: "BUY", token }; }
    if (signal.action === "SELL") { const position = await env.DB.prepare("SELECT quantity,entry_price_usd FROM positions WHERE token_address=?").bind(token).first<{ quantity: string; entry_price_usd: number }>(); if (!position || position.quantity === "0") return consumeSignal(env, signalId, "paper skipped: no position to sell"); const quantity = BigInt(position.quantity); const quoteOut = await quoteSell(client, token, quantity); if (quoteOut <= 0n) return consumeSignal(env, signalId, "paper skipped: fresh sell quote returned zero"); const decimals = Number(meta?.decimals || 18); const exitPriceUsd = monUsd * (Number(quoteOut) / 1e18) / (Number(quantity) / 10 ** decimals); const proceedsMon = Number(quoteOut) / 1e18; const proceedsUsd = proceedsMon * monUsd; const realized = proceedsUsd - Number(position.entry_price_usd || 0) * (Number(quantity) / 10 ** decimals); const balance = await getPaperBalance(env); await env.CIEL_STATE.put(PAPER_BALANCE_KEY, String(balance + proceedsMon)); const oldPnl = Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0"); await env.CIEL_STATE.put(PAPER_REALIZED_PNL_KEY, String(oldPnl + realized)); await env.DB.prepare("DELETE FROM positions WHERE token_address=?").bind(token).run(); const now = Date.now(); await env.DB.prepare(`INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,mode,status,execution_key) VALUES(?,?,?,?,?,?,?,?)`).bind(token, now, "SELL", quantity.toString(), exitPriceUsd, "paper", "FILLED", `paper:${signal.id}`).run(); await setPaperState(env, signalId, "FILLED", { balance_after_mon: balance + proceedsMon, quantity: quantity.toString(), quote_out: quoteOut.toString(), realized_pnl_usd: realized }); await consumeSignal(env, signalId, "paper SELL filled"); await setPaperState(env, signalId, "CONSUMED"); await notifyTelegram(env, `📝 Ciel PAPER SELL\nToken: ${token}\nProceeds: ${proceedsMon} MON\nRealized PnL: $${realized.toFixed(4)}`); return { ok: true, action: "SELL", token }; }
    return consumeSignal(env, signalId, "unsupported signal action");
  } catch (error) { await failPaperExecution(env, signalId, error); return { ok: false, error: String(error).slice(0, 1000) }; } }
