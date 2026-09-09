import type { Env } from "./index";

const CACHE_KEY = "nadfun_market_ranking_cache";
const FETCH_TS_KEY = "nadfun_market_ranking_fetch_ms";
const API_BASE = "https://api.nadapp.net";
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
const FALLBACK_TOKEN_LIMIT = 5;

type TokenRecord = {
  token_info?: Record<string, unknown>;
  market_info?: Record<string, unknown>;
  percent?: number | string;
  [key: string]: unknown;
};

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
  const text = typeof value === "string" ? value : null;
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

function extractTokens(value: unknown, depth = 0): TokenRecord[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.filter(x => x && typeof x === "object") as TokenRecord[];
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokens(object[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

async function save(env: Env, tokens: TokenRecord[]): Promise<number> {
  if (!tokens.length) return 0;
  await env.CIEL_STATE.put(CACHE_KEY, JSON.stringify(tokens.slice(0, 50)), { expirationTtl: 3600 });
  await env.CIEL_STATE.put(FETCH_TS_KEY, String(Date.now()), { expirationTtl: 3600 });
  return tokens.length;
}

async function fetchMarketCapFeed(env: Env): Promise<TokenRecord[]> {
  try {
    const response = await fetch(`${API_BASE}/order/market_cap?page=1&limit=50&is_nsfw=false`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 600 }
    });
    if (!response.ok) return [];
    const body = await response.text();
    return extractTokens(decode(body));
  } catch {
    return [];
  }
}

async function fetchRecentEventTokens(): Promise<string[]> {
  try {
    const response = await fetch("https://nad.fun/api/token/new-event", {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 120 }
    });
    if (!response.ok) return [];
    const body = await response.text();
    const data = decode(body);
    if (!Array.isArray(data)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const event of data) {
      if (!event || typeof event !== "object") continue;
      const type = String((event as Record<string, unknown>).type || "").toUpperCase();
      if (!["BUY", "SELL", "CREATE"].includes(type)) continue;
      const tokenInfo = (event as Record<string, unknown>).token_info;
      const token = tokenInfo && typeof tokenInfo === "object"
        ? address((tokenInfo as Record<string, unknown>).token_id)
        : null;
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
    const response = await fetch(`${API_BASE}/agent/market/${token}`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 300 }
    });
    if (!response.ok) return null;
    const body = await response.text();
    const decoded = decode(body);
    const candidates = extractTokens(decoded);
    const market = candidates[0] ?? (decoded && typeof decoded === "object" ? decoded as TokenRecord : null);
    if (!market) return null;
    const tokenAddress = firstAddress(market) || token;
    return {
      ...market,
      token_info: { ...(market.token_info || {}), token_id: tokenAddress },
      market_info: { ...(market.market_info || {}) }
    };
  } catch {
    return null;
  }
}

export async function primeMarketDiscovery(env: Env): Promise<void> {
  const lastFetch = Number(await env.CIEL_STATE.get(FETCH_TS_KEY) || "0");
  if (lastFetch > 0 && Date.now() - lastFetch < DISCOVERY_REFRESH_MS) return;

  const ranked = await fetchMarketCapFeed(env);
  const rankedWithAddresses = ranked.filter(item => firstAddress(item));
  if (rankedWithAddresses.length) {
    await save(env, rankedWithAddresses);
    return;
  }

  const recentTokens = await fetchRecentEventTokens();
  if (!recentTokens.length) return;
  const fallback: TokenRecord[] = [];
  for (const token of recentTokens) {
    const market = await fetchAgentMarket(token);
    if (market) fallback.push(market);
  }
  if (fallback.length) await save(env, fallback);
}
