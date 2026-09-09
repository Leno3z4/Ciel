import { buildBaseline, deviationScore, buildPatternProfile, askGemini, type Snapshot } from "./model";

type ModelEnv = {
  CIEL_STATE: KVNamespace;
  DB: D1Database;
  GEMINI_API_KEY_1?: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_MODEL: string;
};

type Candidate = {
  token: string;
  samples: number;
  firstTs: number;
  lastTs: number;
  avgVolume: number;
  avgLiquidity: number;
  avgMarketCap: number;
};

const MIN_MARKET_CAP_USD = 90_000;
const MIN_HISTORY_SAMPLES = 12;
const MIN_HISTORY_SPAN_MS = 30 * 60 * 1000;
const MIN_AVG_VOLUME_5M_USD = 5_000;
const MIN_AVG_LIQUIDITY_USD = 10_000;
const MAX_CANDIDATES = 10;
const MODEL_COOLDOWN_MS = 15 * 60 * 1000;
const MODEL_COOLDOWN_PREFIX = "ciel_model_cooldown:";
const RUNTIME_KEY = "ciel_runtime_state";

async function readRuntime(env: ModelEnv): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function writeRuntime(env: ModelEnv, patch: Record<string, unknown>): Promise<void> {
  const current = await readRuntime(env);
  await env.CIEL_STATE.put(RUNTIME_KEY, JSON.stringify({ ...current, ...patch }));
}

async function selectPatternCandidates(env: ModelEnv): Promise<Candidate[]> {
  const rows = await env.DB.prepare(`
    SELECT ms.token_address as token,
      COUNT(*) as samples,
      MIN(ms.ts_ms) as firstTs,
      MAX(ms.ts_ms) as lastTs,
      AVG(ms.volume_5m_usd) as avgVolume,
      AVG(ms.liquidity_usd) as avgLiquidity,
      AVG(ms.market_cap_usd) as avgMarketCap
    FROM market_snapshots ms
    WHERE ms.price_usd>0
      AND ms.ts_ms >= (
        SELECT MIN(recent.ts_ms)
        FROM (
          SELECT ts_ms
          FROM market_snapshots
          WHERE token_address=ms.token_address AND price_usd>0
          ORDER BY ts_ms DESC
          LIMIT ?
        ) recent
      )
    GROUP BY ms.token_address
    HAVING COUNT(*)>=?
      AND (MAX(ms.ts_ms)-MIN(ms.ts_ms))>=?
      AND AVG(ms.volume_5m_usd)>=?
      AND AVG(ms.liquidity_usd)>=?
      AND AVG(ms.market_cap_usd)>=?
    ORDER BY AVG(ms.volume_5m_usd) DESC
    LIMIT ?`
  ).bind(
    MIN_HISTORY_SAMPLES,
    MIN_HISTORY_SAMPLES,
    MIN_HISTORY_SPAN_MS,
    MIN_AVG_VOLUME_5M_USD,
    MIN_AVG_LIQUIDITY_USD,
    MIN_MARKET_CAP_USD,
    MAX_CANDIDATES
  ).all<Candidate>();
  return rows.results || [];
}

async function writeEligibilityDiagnostics(env: ModelEnv): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) as markets,
      SUM(CASE WHEN samples>=? THEN 1 ELSE 0 END) as historyEligible,
      SUM(CASE WHEN samples>=? AND spanMs>=? THEN 1 ELSE 0 END) as spanEligible,
      SUM(CASE WHEN samples>=? AND spanMs>=? AND avgVolume>=? THEN 1 ELSE 0 END) as volumeEligible,
      SUM(CASE WHEN samples>=? AND spanMs>=? AND avgVolume>=? AND avgLiquidity>=? THEN 1 ELSE 0 END) as liquidityEligible,
      SUM(CASE WHEN samples>=? AND spanMs>=? AND avgVolume>=? AND avgLiquidity>=? AND avgMarketCap>=? THEN 1 ELSE 0 END) as establishedEligible
    FROM (
      SELECT ms.token_address,
        COUNT(*) as samples,
        MAX(ms.ts_ms)-MIN(ms.ts_ms) as spanMs,
        AVG(ms.volume_5m_usd) as avgVolume,
        AVG(ms.liquidity_usd) as avgLiquidity,
        AVG(ms.market_cap_usd) as avgMarketCap
      FROM market_snapshots ms
      WHERE ms.price_usd>0
        AND ms.ts_ms >= (
          SELECT MIN(recent.ts_ms)
          FROM (
            SELECT ts_ms
            FROM market_snapshots
            WHERE token_address=ms.token_address AND price_usd>0
            ORDER BY ts_ms DESC
            LIMIT ?
          ) recent
        )
      GROUP BY ms.token_address
    )
  `).bind(
    MIN_HISTORY_SAMPLES,
    MIN_HISTORY_SAMPLES, MIN_HISTORY_SPAN_MS,
    MIN_HISTORY_SAMPLES, MIN_HISTORY_SPAN_MS, MIN_AVG_VOLUME_5M_USD,
    MIN_HISTORY_SAMPLES, MIN_HISTORY_SPAN_MS, MIN_AVG_VOLUME_5M_USD, MIN_AVG_LIQUIDITY_USD,
    MIN_HISTORY_SAMPLES, MIN_HISTORY_SPAN_MS, MIN_AVG_VOLUME_5M_USD, MIN_AVG_LIQUIDITY_USD, MIN_MARKET_CAP_USD,
    MIN_HISTORY_SAMPLES
  ).first<Record<string, number>>();

  await writeRuntime(env, {
    lastModelEligibilityDiagnostics: row || null,
    lastModelEligibilityWindowSamples: MIN_HISTORY_SAMPLES
  });
}

export async function triggerEstablishedModelAnalysis(env: ModelEnv): Promise<void> {
  if (!env.GEMINI_API_KEY_1 && !env.GEMINI_API_KEY_2) {
    await writeRuntime(env, { lastGeminiError: "No Gemini API key configured" });
    return;
  }

  const candidates = await selectPatternCandidates(env);
  await writeEligibilityDiagnostics(env);
  if (!candidates.length) {
    await writeRuntime(env, { lastModelError: "No established high-volume meme candidates above $90,000 yet" });
    return;
  }

  const apiKey = env.GEMINI_API_KEY_1 || env.GEMINI_API_KEY_2;
  if (!apiKey) return;

  let analyzed = 0;
  let lastError: string | undefined;

  for (const candidate of candidates) {
    if (Date.now() - candidate.lastTs < 0) continue;
    const cooldownKey = `${MODEL_COOLDOWN_PREFIX}${candidate.token.toLowerCase()}`;
    const lastAnalyzed = Number(await env.CIEL_STATE.get(cooldownKey) || "0");
    if (lastAnalyzed > 0 && Date.now() - lastAnalyzed < MODEL_COOLDOWN_MS) continue;

    const historyResult = await env.DB.prepare(`SELECT token_address as token,
        ts_ms as tsMs,
        price_usd as priceUsd,
        market_cap_usd as marketCapUsd,
        liquidity_usd as liquidityUsd,
        volume_5m_usd as volume5mUsd,
        buys_5m as buys5m,
        sells_5m as sells5m,
        holders
      FROM market_snapshots
      WHERE token_address=? AND price_usd>0
      ORDER BY ts_ms DESC LIMIT 50`).bind(candidate.token).all<Snapshot>();
    const history = historyResult.results || [];
    if (history.length < MIN_HISTORY_SAMPLES) continue;

    const current = history[0];
    if (!(Number(current.marketCapUsd) >= MIN_MARKET_CAP_USD)) continue;

    await writeRuntime(env, {
      lastGeminiAttempt: Date.now(),
      lastModelError: undefined,
      lastGeminiError: undefined
    });

    try {
      const baseline = buildBaseline(history);
      const score = deviationScore(current, baseline);
      const pattern = buildPatternProfile(history);
      const analysis = await askGemini(apiKey, env.GEMINI_MODEL, "market", current, baseline, score, pattern);
      if (!analysis) {
        lastError = `${candidate.token}: Gemini returned no decision`;
        continue;
      }

      await env.CIEL_STATE.put(cooldownKey, String(Date.now()), { expirationTtl: 3600 });
      analyzed++;

      if (["BUY", "SELL"].includes(analysis.action)) {
        const existingPosition = await env.DB.prepare("SELECT quantity FROM positions WHERE token_address=? AND quantity<>'0'").bind(current.token).first<{ quantity: string }>();
        const allowedForPosition = analysis.action === "BUY" ? !existingPosition : Boolean(existingPosition);
        const duplicate = await env.DB.prepare(`SELECT id FROM signals WHERE token_address=? AND action=? AND ts_ms>? ORDER BY ts_ms DESC LIMIT 1`)
          .bind(current.token, analysis.action, Date.now() - 3600000).first<{ id: number }>();
        if (allowedForPosition && !duplicate) {
          await env.DB.prepare(`INSERT INTO signals(token_address,ts_ms,action,confidence,expected_low,expected_high,anomaly_score,model,rationale) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
            current.token,
            Date.now(),
            analysis.action,
            analysis.confidence,
            analysis.expectedLowUsd,
            analysis.expectedHighUsd,
            analysis.anomalyScore,
            "gemini-established-pattern",
            `${analysis.regime}: ${analysis.rationale}`
          ).run();
        }
      }

      await writeRuntime(env, {
        lastGeminiSuccess: Date.now(),
        lastModelAnalyzed: Date.now(),
        lastModelError: undefined,
        lastGeminiError: undefined
      });
    } catch (error) {
      lastError = `${candidate.token}: ${String(error).slice(0, 700)}`;
      await writeRuntime(env, { lastGeminiError: lastError });
    }
  }

  if (analyzed === 0 && lastError) await writeRuntime(env, { lastGeminiError: lastError });
}
