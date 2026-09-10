import type { Env } from "./index";
import { notifyTelegram } from "./telegram";

const CACHE_KEY = "nadfun_market_ranking_cache";
const FETCH_TS_KEY = "nadfun_market_ranking_fetch_ms";
const FEED_HEALTH_KEY = "ciel_market_feed_health";
const MON_USD_KEY = "mon_usd";
const TELEGRAM_PULSE_KEY = "ciel_telegram_market_pulse_ms";
const API_BASE = "https://api.nadapp.net";
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
const TELEGRAM_PULSE_INTERVAL_MS = 10 * 60 * 1000;
const MARKET_LIMIT = 50;
const FALLBACK_TOKEN_LIMIT = 8;

type TokenRecord = {
  token_info?: Record<string, unknown>;
  market_info?: Record<string, unknown>;
  percent?: number | string;
  [key: string]: unknown;
};

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const text = value.trim().replace(/[$,\s]/g, "");
  if (!text) return 0;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(K|M|B|T)?$/i);
  if (!match) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return base * (match[2] ? multipliers[match[2].toUpperCase()] : 1);
}

function decode(value: string): unknown | null {
  let raw = value.trim();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") raw = parsed.trim();
    else return parsed;
  } catch {}

  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = atob(padded);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes, c => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

function address(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^0x[a-fA-F0-9]{40}$/.test(text) ? text : null;
}

function firstAddress(item: TokenRecord): string | null {
  const sources = [item.token_info, item.market_info, item.token, item.market, item];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of ["token_id", "token_address", "tokenAddress", "address", "mint", "id"]) {
      const found = address((source as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return null;
}

function objectValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return null;
  const object = source as Record<string, unknown>;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return null;
}

function nestedNumber(item: TokenRecord, tokenKeys: string[], marketKeys: string[]): number {
  return num(objectValue(item.market_info, marketKeys)) || num(objectValue(item.token_info, tokenKeys));
}

function extractTokens(value: unknown, depth = 0): TokenRecord[] {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) return value.filter(x => x && typeof x === "object") as TokenRecord[];
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;

  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokens(object[key], depth + 1);
    if (found.length) return found;
  }

  return [];
}

function marketCap(item: TokenRecord): number {
  return nestedNumber(
    item,
    ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"],
    ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"]
  );
}

function liquidity(item: TokenRecord): number {
  return nestedNumber(
    item,
    ["liquidity_usd", "liquidityUsd"],
    ["liquidity_usd", "liquidityUsd"]
  );
}

function volume5m(item: TokenRecord): number {
  return nestedNumber(
    item,
    ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"],
    ["volume_5m_usd", "volume5mUsd", "volume_usd_5m"]
  );
}

function symbol(item: TokenRecord): string {
  const value = objectValue(item.token_info, ["symbol"]);
  return typeof value === "string" && value.trim()
    ? value.trim()
    : firstAddress(item)?.slice(0, 10) || "unknown";
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function estimateMonUsd(tokens: TokenRecord[]): number {
  const estimates: number[] = [];
  for (const item of tokens) {
    const tokenInMon = nestedNumber(item, [], ["price", "token_price"]);
    const tokenUsd = nestedNumber(item, ["price_usd", "priceUsd"], ["price_usd", "priceUsd"]);
    if (tokenInMon > 0 && tokenUsd > 0) {
      const ratio = tokenUsd / tokenInMon;
      if (ratio > 0.01 && ratio < 1_000) estimates.push(ratio);
    }

    const direct = nestedNumber(
      item,
      [],
      ["mon_price_usd", "native_price_usd", "quote_price_usd"]
    );
    if (direct > 0) estimates.push(direct);
  }

  if (!estimates.length) return 0;
  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)] || 0;
}

async function save(env: Env, tokens: TokenRecord[], source: string): Promise<number> {
  if (!tokens.length) return 0;
  const normalized = tokens
    .filter(item => firstAddress(item))
    .slice(0, MARKET_LIMIT);

  if (!normalized.length) return 0;

  const fetchedAt = Date.now();
  await env.CIEL_STATE.put(
    CACHE_KEY,
    JSON.stringify(normalized),
    { expirationTtl: 3600 }
  );
  await env.CIEL_STATE.put(
    FETCH_TS_KEY,
    String(fetchedAt),
    { expirationTtl: 3600 }
  );

  const monUsd = estimateMonUsd(normalized);
  if (monUsd > 0) {
    await env.CIEL_STATE.put(
      MON_USD_KEY,
      String(monUsd),
      { expirationTtl: 3600 }
    );
  }

  const ranked = normalized
    .map(item => ({
      symbol: symbol(item),
      token: firstAddress(item),
      marketCapUsd: marketCap(item),
      liquidityUsd: liquidity(item),
      volume5mUsd: volume5m(item),
      percent: num(item.percent)
    }))
    .filter(item => item.token && item.marketCapUsd > 0)
    .sort((a, b) => b.marketCapUsd - a.marketCapUsd);

  const top = ranked[0];
  await env.CIEL_STATE.put(
    FEED_HEALTH_KEY,
    JSON.stringify({
      ok: true,
      source,
      fetchedAt,
      count: normalized.length,
      validCount: ranked.length,
      topMarketCapUsd: top?.marketCapUsd || 0,
      topSymbol: top?.symbol || null,
      monUsd: monUsd || null
    }),
    { expirationTtl: 3600 }
  );

  await maybeSendMarketPulse(env, ranked, source, fetchedAt);
  return normalized.length;
}

async function fetchFeed(url: string): Promise<TokenRecord[]> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Ciel-NadFun/2.0"
      },
      cf: { cacheTtl: 600 }
    });
    if (!response.ok) return [];
    return extractTokens(decode(await response.text()));
  } catch {
    return [];
  }
}

async function fetchMarketCapFeed(): Promise<TokenRecord[]> {
  return fetchFeed(
    `${API_BASE}/order/market_cap?page=1&limit=${MARKET_LIMIT}&is_nsfw=false&direction=DESC`
  );
}

async function fetchCreationFeed(): Promise<TokenRecord[]> {
  return fetchFeed(
    `${API_BASE}/order/creation_time?page=1&limit=${MARKET_LIMIT}&is_nsfw=false&direction=DESC`
  );
}

async function fetchRecentEventTokens(): Promise<string[]> {
  try {
    const response = await fetch(
      "https://nad.fun/api/token/new-event",
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Ciel-NadFun/2.0"
        },
        cf: { cacheTtl: 120 }
      }
    );
    if (!response.ok) return [];
    const body = await response.text();
    const data = decode(body);
    if (!Array.isArray(data)) return [];

    const result: string[] = [];
    const seen = new Set<string>();

    for (const event of data) {
      if (!event || typeof event !== "object") continue;
      const object = event as Record<string, unknown>;
      const type = String(object.type || "").toUpperCase();
      if (!["BUY", "SELL", "CREATE"].includes(type)) continue;

      const tokenInfo = object.token_info;
      const token = tokenInfo && typeof tokenInfo === "object"
        ? address((tokenInfo as Record<string, unknown>).token_id)
        : address(object.token_id) || address(object.token_address);

      if (token && !seen.has(token.toLowerCase())) {
        seen.add(token.toLowerCase());
        result.push(token);
        if (result.length >= FALLBACK_TOKEN_LIMIT) break;
      }
    }

    return result;
  } catch {
    return [];
  }
}

async function fetchAgentMarket(token: string): Promise<TokenRecord | null> {
  try {
    const response = await fetch(
      `${API_BASE}/agent/market/${token}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Ciel-NadFun/2.0"
        },
        cf: { cacheTtl: 300 }
      }
    );
    if (!response.ok) return null;
    const decoded = decode(await response.text());
    const candidates = extractTokens(decoded);
    const market = candidates[0] ?? (
      decoded && typeof decoded === "object"
        ? decoded as TokenRecord
        : null
    );
    if (!market) return null;

    const tokenAddress = firstAddress(market) || token;
    return {
      ...market,
      token_info: {
        ...(market.token_info || {}),
        token_id: tokenAddress
      },
      market_info: {
        ...(market.market_info || {})
      }
    };
  } catch {
    return null;
  }
}

async function maybeSendMarketPulse(
  env: Env,
  ranked: Array<{
    symbol: string;
    token: string | null;
    marketCapUsd: number;
    liquidityUsd: number;
    volume5mUsd: number;
    percent: number;
  }>,
  source: string,
  fetchedAt: number
): Promise<void> {
  const lastPulse = Number(
    await env.CIEL_STATE.get(TELEGRAM_PULSE_KEY) || "0"
  );
  if (lastPulse > 0 && fetchedAt - lastPulse < TELEGRAM_PULSE_INTERVAL_MS) return;

  const lines = ranked.slice(0, 8).map((item, index) => {
    const change = Number.isFinite(item.percent) && item.percent !== 0
      ? ` | ${item.percent > 0 ? "+" : ""}${item.percent.toFixed(2)}%`
      : "";
    const volume = item.volume5mUsd > 0 ? ` | V5m ${formatUsd(item.volume5mUsd)}` : "";
    const liquidityLine = item.liquidityUsd > 0 ? ` | LQ ${formatUsd(item.liquidityUsd)}` : "";
    return `${index + 1}. ${item.symbol} — MC ${formatUsd(item.marketCapUsd)}${liquidityLine}${volume}${change}`;
  });

  if (!lines.length) return;

  const healthRaw = await env.CIEL_STATE.get(FEED_HEALTH_KEY);
  let health: Record<string, unknown> = {};
  try { health = healthRaw ? JSON.parse(healthRaw) as Record<string, unknown> : {}; } catch {}

  const stale = source === "cached-fallback";
  const status = stale ? "⚠️ STALE/CACHED" : "✅ LIVE FEED";
  const monUsd = Number(health.monUsd || 0);
  const sourceLabel = source === "market-cap"
    ? "market-cap"
    : source === "creation-time"
      ? "creation-time fallback"
      : source;

  await notifyTelegram(
    env,
    `📡 CIEL MARKET INTELLIGENCE\n${status}\nSource: ${sourceLabel}\nMarkets cached: ${Number(health.count || ranked.length)}${monUsd > 0 ? `\nMON/USD: $${monUsd.toFixed(4)}` : ""}\n\nTOP NAD.FUN MARKETS\n${lines.join("\n")}\n\nKV discovery is active; D1 availability does not stop this scanner.`
  );

  await env.CIEL_STATE.put(
    TELEGRAM_PULSE_KEY,
    String(fetchedAt),
    { expirationTtl: 172800 }
  );
}

async function sendCachedPulse(env: Env): Promise<void> {
  const cached = await env.CIEL_STATE.get(CACHE_KEY);
  if (!cached) return;

  try {
    const tokens = extractTokens(JSON.parse(cached));
    const ranked = tokens
      .map(item => ({
        symbol: symbol(item),
        token: firstAddress(item),
        marketCapUsd: marketCap(item),
        liquidityUsd: liquidity(item),
        volume5mUsd: volume5m(item),
        percent: num(item.percent)
      }))
      .filter(item => item.token && item.marketCapUsd > 0)
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd);

    await maybeSendMarketPulse(
      env,
      ranked,
      "cached-fallback",
      Date.now()
    );
  } catch {}
}

export async function primeMarketDiscovery(env: Env): Promise<void> {
  const lastFetch = Number(
    await env.CIEL_STATE.get(FETCH_TS_KEY) || "0"
  );

  if (lastFetch > 0 && Date.now() - lastFetch < DISCOVERY_REFRESH_MS) return;

  const ranked = await fetchMarketCapFeed();
  if (ranked.length) {
    await save(env, ranked, "market-cap");
    return;
  }

  const creation = await fetchCreationFeed();
  if (creation.length) {
    await save(env, creation, "creation-time");
    return;
  }

  const recentTokens = await fetchRecentEventTokens();
  if (recentTokens.length) {
    const fallback: TokenRecord[] = [];
    for (const token of recentTokens) {
      const market = await fetchAgentMarket(token);
      if (market) fallback.push(market);
    }
    if (fallback.length) {
      await save(env, fallback, "recent-events");
      return;
    }
  }

  await sendCachedPulse(env);
}
