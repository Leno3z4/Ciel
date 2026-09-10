import { buildBaseline, deviationScore, buildPatternProfile, askGemini, type Snapshot } from "./model";
import { runDecisionPipeline } from "./decision_orchestrator";
type ModelEnv = {
  CIEL_STATE: KVNamespace;
  DB: D1Database;
  GEMINI_API_KEY_1?: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  GEMINI_API_KEY_6?: string;
  GEMINI_API_KEY_7?: string;
  GEMINI_MODEL: string;
};

type Candidate = {
  token: string;
  samples: number;
  firstTs: number;
  lastTs: number;
  avgMarketCap: number;
};

type FeedToken = { token_info?: Record<string, unknown>; market_info?: Record<string, unknown>; [key: string]: unknown };

const MIN_MARKET_CAP_USD = 90_000;
const MIN_HISTORY_SAMPLES = 12;
const MIN_HISTORY_SPAN_MS = 30 * 60 * 1000;
const MIN_AVG_VOLUME_5M_USD = 5_000;
const MIN_AVG_LIQUIDITY_USD = 10_000;
const MAX_CANDIDATE_POOL = 20;
const MAX_CANDIDATES = 3;
const MAX_DECISIONS_PER_CYCLE = 3;
const MODEL_COOLDOWN_MS = 15 * 60 * 1000;
const MODEL_KEY_COOLDOWN_MS = 60 * 1000;
const MODEL_COOLDOWN_PREFIX = "ciel_model_cooldown:";
const MODEL_KEY_COOLDOWN_PREFIX = "ciel_gemini_key_cooldown:";
const MODEL_KEY_CURSOR = "ciel_gemini_key_cursor";
const RUNTIME_KEY = "ciel_runtime_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const MON_USD_KEY = "mon_usd";
const DECISION_KEY_COUNT = 7;

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const text = value.trim().replace(/[$,\s]/g, "");
  if (!text) return 0;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(K|M|B|T)?$/i);
  if (!match) { const parsed = Number(text); return Number.isFinite(parsed) ? parsed : 0; }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return base * (match[2] ? multipliers[match[2].toUpperCase()] : 1);
}

function objectValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  return null;
}

function nestedNumber(item: FeedToken, tokenKeys: string[], marketKeys: string[]): number {
  return num(objectValue(item.market_info, marketKeys)) || num(objectValue(item.token_info, tokenKeys));
}

function feedTokenAddress(item: FeedToken): string | null {
  const value = objectValue(item.token_info, ["token_id", "token_address", "tokenAddress"]) || objectValue(item.market_info, ["token_id", "token_address", "tokenAddress"]);
  const text = typeof value === "string" ? value : "";
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text.toLowerCase() : null;
}

function decodeApiBody(body: string): unknown | null {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "string") return parsed;
    return JSON.parse(parsed);
  } catch {}
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = atob(padded);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0))));
  } catch { return null; }
}

function extractTokens(value: unknown, depth = 0): FeedToken[] {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return value.filter(x => x && typeof x === "object") as FeedToken[];
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokens(object[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function feedVolumeUsd(item: FeedToken, monUsd: number): number {
  const directUsd = nestedNumber(item, ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"], ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"]);
  if (directUsd > 0) return directUsd;
  const rawVolume = nestedNumber(item, [], ["volume_5m", "volume5m", "volume"]);
  if (rawVolume <= 0 || monUsd <= 0) return 0;
  return rawVolume >= 1e15 ? rawVolume / 1e18 * monUsd : rawVolume * monUsd;
}

function feedLiquidityUsd(item: FeedToken, monUsd: number): number {
  const directUsd = nestedNumber(item, ["liquidity_usd", "liquidityUsd"], ["liquidity_usd", "liquidityUsd"]);
  if (directUsd > 0) return directUsd;
  const rawReserve = num(objectValue(item.market_info, ["reserve_native"])) || num(objectValue(item.token_info, ["reserve_native"]));
  if (rawReserve <= 0 || monUsd <= 0) return 0;
  return rawReserve >= 1e12 ? rawReserve / 1e18 * monUsd : rawReserve * monUsd;
}

function feedMarketCapUsd(item: FeedToken): number {
  return nestedNumber(
    item,
    ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"],
    ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"]
  );
}

async function readRuntime(env: ModelEnv): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

async function writeRuntime(env: ModelEnv, patch: Record<string, unknown>): Promise<void> {
  const current = await readRuntime(env);
  await env.CIEL_STATE.put(RUNTIME_KEY, JSON.stringify({ ...current, ...patch }));
}

async function readCurrentFeed(env: ModelEnv): Promise<Map<string, FeedToken>> {
  const raw = await env.CIEL_STATE.get(RANKING_CACHE_KEY);
  if (!raw) return new Map();
  try {
    const tokens = extractTokens(JSON.parse(raw));
    return new Map(tokens.map(item => [feedTokenAddress(item), item]).filter(([key]) => Boolean(key)) as Array<[string, FeedToken]>);
  } catch { return new Map(); }
}

async function selectPatternCandidates(env: ModelEnv): Promise<Candidate[]> {
  const feed = await readCurrentFeed(env);
  if (!feed.size) return [];

  const pool = Array.from(feed.entries())
    .map(([token, item]) => ({
      token,
      marketCap: feedMarketCapUsd(item)
    }))
    .filter(item => item.marketCap >= MIN_MARKET_CAP_USD)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, MAX_CANDIDATE_POOL);

  if (!pool.length) return [];

  const placeholders = pool.map(() => "?").join(",");
  const rows = await env.DB.prepare(`
    SELECT token_address as token,
      COUNT(*) as samples,
      MIN(ts_ms) as firstTs,
      MAX(ts_ms) as lastTs,
      AVG(market_cap_usd) as avgMarketCap
    FROM market_snapshots ms
    WHERE ms.price_usd>0
      AND ms.ts_ms >= ?
      AND ms.token_address IN (${placeholders})
    GROUP BY ms.token_address
    HAVING COUNT(*)>=?
      AND (MAX(ms.ts_ms)-MIN(ms.ts_ms))>=?
      AND AVG(ms.market_cap_usd)>=?
    ORDER BY AVG(ms.market_cap_usd) DESC
    LIMIT ?`).bind(
    Date.now() - 2 * 60 * 60 * 1000,
    ...pool.map(item => item.token),
    MIN_HISTORY_SAMPLES,
    MIN_HISTORY_SPAN_MS,
    MIN_MARKET_CAP_USD,
    MAX_CANDIDATES
  ).all<Candidate>();

  return rows.results || [];
}

async function writeEligibilityDiagnostics(env: ModelEnv, candidates: Candidate[]): Promise<void> {
  const feed = await readCurrentFeed(env);
  const monUsd = Number(await env.CIEL_STATE.get(MON_USD_KEY) || "0");
  let volumeEligible = 0;
  let liquidityEligible = 0;
  let establishedEligible = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const candidate of candidates) {
    const item = feed.get(candidate.token.toLowerCase());
    const volumeUsd = item ? feedVolumeUsd(item, monUsd) : 0;
    const liquidityUsd = item ? feedLiquidityUsd(item, monUsd) : 0;
    const volumeOk = volumeUsd >= MIN_AVG_VOLUME_5M_USD;
    const liquidityOk = liquidityUsd >= MIN_AVG_LIQUIDITY_USD;
    if (volumeOk) volumeEligible++;
    if (volumeOk && liquidityOk) liquidityEligible++;
    if (volumeOk && liquidityOk && candidate.avgMarketCap >= MIN_MARKET_CAP_USD) establishedEligible++;
    if (samples.length < 10) samples.push({ token: candidate.token, volumeUsd, liquidityUsd, avgMarketCap: candidate.avgMarketCap });
  }

  await writeRuntime(env, {
    lastModelEligibilityDiagnostics: {
      markets: candidates.length,
      historyEligible: candidates.length,
      spanEligible: candidates.length,
      volumeEligible,
      liquidityEligible,
      establishedEligible,
      samples
    },
    lastModelEligibilityWindowSamples: MIN_HISTORY_SAMPLES,
    lastModelDecisionBudgetPerCycle: MAX_DECISIONS_PER_CYCLE,
    lastModelDecisionKeyCount: DECISION_KEY_COUNT
  });
}

function isFallbackWorthy(error: unknown): boolean {
  const text = String(error);
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit|401|403|api.?key|permission/i.test(text);
}

async function getKeySlots(env: ModelEnv): Promise<Array<{ index: number; key: string }>> {
  const keys = [
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
    env.GEMINI_API_KEY_5,
    env.GEMINI_API_KEY_6,
    env.GEMINI_API_KEY_7
  ].map(key => (key || "").trim()).filter(Boolean);
  if (!keys.length) return [];
  const cursor = Math.max(0, Math.min(keys.length - 1, Number(await env.CIEL_STATE.get(MODEL_KEY_CURSOR) || "0")));
  const ordered: Array<{ index: number; key: string }> = [];
  for (let offset = 0; offset < keys.length; offset++) {
    const index = (cursor + offset) % keys.length;
    ordered.push({ index: index + 1, key: keys[index] });
  }
  return ordered;
}

async function askGeminiWithFallbacks(
  env: ModelEnv,
  model: string,
  snapshot: Snapshot,
  baseline: ReturnType<typeof buildBaseline>,
  score: number,
  pattern: ReturnType<typeof buildPatternProfile>
): Promise<{ decision: Awaited<ReturnType<typeof askGemini>>; keyIndex: number }> {
  const slots = await getKeySlots(env);
  let lastError: unknown = new Error("No Gemini API key configured");
  let attempted = 0;
  for (const slot of slots) {
    const cooldown = Number(await env.CIEL_STATE.get(`${MODEL_KEY_COOLDOWN_PREFIX}${slot.index}`) || "0");
    if (cooldown > Date.now()) continue;
    attempted++;
    try {
      const decision = await askGemini(slot.key, model, "market", snapshot, baseline, score, pattern);
      await env.CIEL_STATE.put(MODEL_KEY_CURSOR, String(slot.index % DECISION_KEY_COUNT), { expirationTtl: 86400 });
      await writeRuntime(env, { lastGeminiKeyUsed: slot.index, lastGeminiFallbacks: Math.max(0, attempted - 1) });
      return { decision, keyIndex: slot.index };
    } catch (error) {
      lastError = error;
      if (isFallbackWorthy(error)) {
        await env.CIEL_STATE.put(`${MODEL_KEY_COOLDOWN_PREFIX}${slot.index}`, String(Date.now() + MODEL_KEY_COOLDOWN_MS), { expirationTtl: 300 });
        continue;
      }
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function triggerEstablishedModelAnalysis(env: ModelEnv): Promise<void> {
  const keys = await getKeySlots(env);
  if (!keys.length) {
    await writeRuntime(env, { lastGeminiError: "No Gemini API key configured" });
    return;
  }

  const candidates = await selectPatternCandidates(env);
  await writeEligibilityDiagnostics(env, candidates);
  const feed = await readCurrentFeed(env);
  const monUsd = Number(await env.CIEL_STATE.get(MON_USD_KEY) || "0");

  const established: Candidate[] = [];
  for (const candidate of candidates) {
    const item = feed.get(candidate.token.toLowerCase());
    if (item && feedVolumeUsd(item, monUsd) >= MIN_AVG_VOLUME_5M_USD && feedLiquidityUsd(item, monUsd) >= MIN_AVG_LIQUIDITY_USD) established.push(candidate);
  }

  if (!established.length) {
    await writeRuntime(env, { lastModelError: "No established high-volume meme candidates above $90,000 yet" });
    return;
  }

  const ranked: Array<{ candidate: Candidate; history: Snapshot[]; score: number; pattern: ReturnType<typeof buildPatternProfile>; baseline: ReturnType<typeof buildBaseline> }> = [];
  for (const candidate of established) {
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
      ORDER BY ts_ms DESC LIMIT 12`).bind(candidate.token).all<Snapshot>();
    const history = historyResult.results || [];
    if (history.length < MIN_HISTORY_SAMPLES) continue;
    const current = history[0];
    if (!(Number(current.marketCapUsd) >= MIN_MARKET_CAP_USD)) continue;
    const baseline = buildBaseline(history);
    const score = deviationScore(current, baseline);
    const pattern = buildPatternProfile(history);
    ranked.push({ candidate, history, score, pattern, baseline });
  }

  ranked.sort((a, b) => b.score - a.score || b.candidate.avgMarketCap - a.candidate.avgMarketCap);
  let analyzed = 0;
  let lastError: string | undefined;

  for (const entry of ranked.slice(0, MAX_DECISIONS_PER_CYCLE)) {
    const { candidate, history, score, pattern, baseline } = entry;
    const cooldownKey = `${MODEL_COOLDOWN_PREFIX}${candidate.token.toLowerCase()}`;
    const lastAnalyzed = Number(await env.CIEL_STATE.get(cooldownKey) || "0");
    if (lastAnalyzed > 0 && Date.now() - lastAnalyzed < MODEL_COOLDOWN_MS) continue;
    const current = history[0];

    await writeRuntime(env, {
      lastGeminiAttempt: Date.now(),
      lastModelError: undefined,
      lastGeminiError: undefined,
      lastModelDecisionCandidate: candidate.token
    });

    try {
      const result = await runDecisionPipeline(
        env,
        [current],
        async () => {
          const response = await askGeminiWithFallbacks(
            env,
            env.GEMINI_MODEL,
            current,
            baseline,
            score,
            pattern
          );

          const decision = response.decision;

          if (!decision) {
            throw new Error("Gemini returned no decision");
          }

          const normalizedAction =
            decision.action === "HOLD" || decision.action === "IGNORE"
              ? "WAIT"
              : decision.action;

          return {
            token: candidate.token,
            action: normalizedAction,
            confidence: decision.confidence ?? 0,
            rationale: decision.rationale ?? "",
            liquidityUsd: Number(current.liquidityUsd ?? 0),
            slippageBps: 0,
            portfolioExposurePct: 0,
            positionPct: 0,
            priceChangePct: 0,
            expectedLowUsd: decision.expectedLowUsd ?? 0,
            expectedHighUsd: decision.expectedHighUsd ?? 0,
            anomalyScore: decision.anomalyScore ?? score,
            regime: decision.regime ?? pattern.regimeHint
          };
        }
      );
      const analysis = result;
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
        lastGeminiError: undefined,
        lastModelDecisionAction: analysis.action,
        lastModelDecisionConfidence: analysis.confidence
      });
    } catch (error) {
      lastError = `${candidate.token}: ${String(error).slice(0, 700)}`;
      await writeRuntime(env, { lastGeminiError: lastError });
    }
  }

  if (analyzed === 0 && lastError) await writeRuntime(env, { lastGeminiError: lastError });
}
