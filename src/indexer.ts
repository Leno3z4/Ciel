import { parseAbiItem } from "viem";
import { NADFUN_BONDING, publicClient } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const tokenMetaAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

export interface IndexResult {
  fromBlock: bigint;
  toBlock: bigint;
  creates: number;
  buys: number;
  sells: number;
  graduates: number;
  syncs: number;
  snapshots: number;
  nextBlock: bigint;
}

type IndexEnv = { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA?: R2Bucket; NAD_RPC_URL?: string };
type NadFunToken = { token_info?: Record<string, unknown>; market_info?: Record<string, unknown>; percent?: number | string; [key: string]: unknown };
type ChartRow = { t: number; c: number; v: number };
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };

type TokenMeta = {
  address: string;
  total_supply: string | null;
  decimals: number;
  quote_token: string | null;
  pair_address: string | null;
  graduated: number;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
};

const INDEXER_STATE_KEY = "indexer_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const RANKING_FETCH_TS_KEY = "nadfun_market_ranking_fetch_ms";
const CREATION_CACHE_KEY = "nadfun_creation_discovery_cache";
const CREATION_FETCH_TS_KEY = "nadfun_creation_discovery_fetch_ms";
const RPC_LOG_RANGE_BLOCKS = 100;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const MARKET_LIMIT = 50;
const DISCOVERY_LIMIT = 50;
const SNAPSHOT_LIMIT = 12;
const MIN_MARKET_CAP_USD = 90_000;
const API_BASE = "https://api.nadapp.net";
const RANKING_REFRESH_MS = 10 * 60 * 1000;
const DISCOVERY_REFRESH_MS = 30 * 60 * 1000;
const MAX_CHART_ATTEMPTS = 3;

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function isAddress(value: string | null): value is `0x${string}` {
  return !!value && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function units(value: unknown, decimals: number): number {
  const parsed = num(value);
  if (!(parsed > 0)) return 0;
  return parsed >= 1e15 ? parsed / 10 ** Math.max(0, decimals) : parsed;
}

function decode(text: string): unknown | null {
  let raw = text.trim();
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

function recordValue(item: NadFunToken, keys: string[]): unknown {
  const sources: unknown[] = [item.token_info, item.market_info, item.token, item.market, item];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const value = (source as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return null;
}

function tokenAddress(item: NadFunToken): string | null {
  const value = str(recordValue(item, ["token_id", "token_address", "tokenAddress", "address", "mint", "id"]));
  return isAddress(value) ? value : null;
}

function marketCap(item: NadFunToken, decimals: number): number {
  const direct = num(recordValue(item, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap"]));
  if (direct > 0) return direct;
  const price = num(recordValue(item, ["price_usd", "priceUsd", "price", "token_price_usd", "tokenPriceUsd"]));
  const supply = units(recordValue(item, ["total_supply", "totalSupply", "supply"]), decimals);
  return price > 0 && supply > 0 ? price * supply : 0;
}

function price(item: NadFunToken): number {
  return num(recordValue(item, ["price_usd", "priceUsd", "price", "token_price_usd", "tokenPriceUsd"]));
}

function totalSupply(item: NadFunToken | undefined, meta: TokenMeta | null, decimals: number): number {
  if (item) {
    const direct = units(recordValue(item, ["total_supply", "totalSupply", "supply"]), decimals);
    if (direct > 0) return direct;
  }
  return meta?.total_supply ? units(meta.total_supply, decimals) : 0;
}

function decimalsValue(item: NadFunToken | undefined, fallback: number): number {
  if (!item) return fallback;
  const value = num(recordValue(item, ["decimals", "token_decimals", "tokenDecimals"]));
  return value > 0 ? Math.floor(value) : fallback;
}

function liquidity(item: NadFunToken): number {
  const direct = num(recordValue(item, ["liquidity_usd", "liquidityUsd", "liquidity"]));
  if (direct > 0) return direct;
  const reserve = num(recordValue(item, ["reserve_native_usd", "reserveNativeUsd"]));
  return reserve > 0 ? reserve * 2 : 0;
}

function volume5m(item: NadFunToken): number {
  return num(recordValue(item, ["volume_5m_usd", "volume5mUsd", "volume_5m", "volume5m"]));
}

function holders(item: NadFunToken): number {
  return num(recordValue(item, ["holder_count", "holderCount", "holders"]));
}

function quote(item: NadFunToken): string | null {
  return str(recordValue(item, ["quote_id", "quoteId", "quote_token", "quoteToken"]));
}

function pair(item: NadFunToken): string | null {
  return str(recordValue(item, ["pair_address", "pairAddress", "market_id", "marketId"]));
}

function graduated(item: NadFunToken): number {
  const marketType = str(recordValue(item, ["market_type", "marketType"]));
  return marketType?.toUpperCase().includes("DEX") || item.token_info?.is_graduated === true || item.token_info?.isGraduated === true ? 1 : 0;
}

function extractTokenArray(value: unknown, depth = 0): NadFunToken[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.filter(item => item && typeof item === "object") as NadFunToken[];
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokenArray(object[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

async function fetchRanked(env: IndexEnv, creationFallback = false): Promise<NadFunToken[]> {
  const cacheKey = creationFallback ? CREATION_CACHE_KEY : RANKING_CACHE_KEY;
  const timestampKey = creationFallback ? CREATION_FETCH_TS_KEY : RANKING_FETCH_TS_KEY;
  const refreshMs = creationFallback ? DISCOVERY_REFRESH_MS : RANKING_REFRESH_MS;
  const path = creationFallback
    ? "/order/creation_time?page=1&limit=50&is_nsfw=false&direction=DESC"
    : `/order/market_cap?page=1&limit=${MARKET_LIMIT}&is_nsfw=false&direction=DESC`;

  const cached = await env.CIEL_STATE.get(cacheKey);
  const lastFetch = num(await env.CIEL_STATE.get(timestampKey));
  if (cached && Date.now() - lastFetch < refreshMs) {
    try {
      const cachedTokens = extractTokenArray(JSON.parse(cached));
      if (cachedTokens.length) return cachedTokens;
    } catch {}
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: creationFallback ? 1800 : 600 }
    });
    const body = await response.text();
    if (response.ok) {
      const tokens = extractTokenArray(decode(body));
      if (tokens.length) {
        await env.CIEL_STATE.put(cacheKey, JSON.stringify(tokens), { expirationTtl: 3600 });
        await env.CIEL_STATE.put(timestampKey, String(Date.now()), { expirationTtl: 3600 });
        return tokens;
      }
      console.error(`NadFun discovery returned no tokens (${creationFallback ? "creation_time" : "market_cap"})`);
    } else {
      console.error(`NadFun discovery HTTP ${response.status} (${creationFallback ? "creation_time" : "market_cap"})`);
    }
  } catch (error) {
    console.error(`NadFun discovery failed: ${String(error).slice(0, 400)}`);
  }

  if (cached) {
    try {
      const cachedTokens = extractTokenArray(JSON.parse(cached));
      if (cachedTokens.length) return cachedTokens;
    } catch {}
  }
  return [];
}

async function fetchChart(token: string): Promise<ChartRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 24 * 3600;
  try {
    const response = await fetch(`${API_BASE}/trade/chart/${token}?resolution=60&from=${from}&to=${now}&countback=168&chart_type=market_cap_usd`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 300 }
    });
    if (!response.ok) return [];
    const data = await response.json() as { s?: string; t?: unknown[]; c?: unknown[]; v?: unknown[] };
    if (data.s !== "ok" || !Array.isArray(data.t) || !Array.isArray(data.c)) return [];
    const result: ChartRow[] = [];
    for (let i = 0; i < data.t.length; i++) {
      const cap = num(data.c[i]);
      if (cap > 0) result.push({ t: num(data.t[i]), c: cap, v: num(data.v?.[i]) });
    }
    return result;
  } catch {
    return [];
  }
}

async function seed(env: IndexEnv, token: string, item?: NadFunToken, createdAtBlock?: bigint): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET
      symbol=COALESCE(excluded.symbol,tokens.symbol),
      name=COALESCE(excluded.name,tokens.name),
      last_seen_ms=excluded.last_seen_ms,
      total_supply=COALESCE(excluded.total_supply,tokens.total_supply),
      decimals=excluded.decimals,
      quote_token=COALESCE(excluded.quote_token,tokens.quote_token),
      pair_address=COALESCE(excluded.pair_address,tokens.pair_address),
      graduated=MAX(tokens.graduated,excluded.graduated),
      created_at_block=COALESCE(tokens.created_at_block,excluded.created_at_block)`).bind(
    token,
    item ? str(recordValue(item, ["symbol"])) : null,
    item ? str(recordValue(item, ["name"])) : null,
    item ? marketCap(item, decimalsValue(item, 18)) : 0,
    item ? liquidity(item) : 0,
    now,
    now,
    item ? recordValue(item, ["total_supply", "totalSupply", "supply"]) : null,
    Math.max(0, decimalsValue(item, 18)),
    item ? quote(item) : null,
    item ? pair(item) : null,
    item ? graduated(item) : 0,
    createdAtBlock !== undefined ? Number(createdAtBlock) : null
  ).run();
}

export async function indexNadFun(env: IndexEnv, maxBlocks = RPC_LOG_RANGE_BLOCKS): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const rawState = await env.CIEL_STATE.get(INDEXER_STATE_KEY);
  const state = rawState ? JSON.parse(rawState) as IndexerState : null;
  const cursor = state?.nextBlock ?? await env.CIEL_STATE.get("indexer_next_block");
  let fromBlock = cursor ? BigInt(cursor) : (latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n);
  if (latest - fromBlock > MAX_ACCEPTABLE_LAG_BLOCKS) fromBlock = latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n;
  if (fromBlock > latest) return null;

  const blockCount = Math.max(1, Math.min(Math.floor(maxBlocks), RPC_LOG_RANGE_BLOCKS));
  const toBlock = fromBlock + BigInt(blockCount - 1) > latest ? latest : fromBlock + BigInt(blockCount - 1);

  const creates = await client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock });

  for (const log of creates) {
    const args = log.args;
    if (!args.token || !args.quoteToken || !args.pair) continue;
    const [supply, decimals] = await Promise.all([
      client.readContract({ address: args.token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null),
      client.readContract({ address: args.token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18)
    ]);
    await seed(env, args.token, { token_info: { token_id: args.token, name: args.name, symbol: args.symbol, total_supply: supply?.toString() ?? null, decimals: Number(decimals) }, market_info: { quote_token: args.quoteToken, pair_address: args.pair } }, log.blockNumber);
  }

  let discovery = await fetchRanked(env);
  if (!discovery.length) discovery = await fetchRanked(env, true);

  const rankedByToken = new Map<string, NadFunToken>();
  let validAddressCount = 0;
  for (const item of discovery) {
    const token = tokenAddress(item);
    if (!token) continue;
    rankedByToken.set(token.toLowerCase(), item);
    validAddressCount++;
  }
  for (const item of discovery) {
    const token = tokenAddress(item);
    if (token) await seed(env, token, item);
  }

  const existing = await env.DB.prepare(`SELECT address,total_supply,decimals,quote_token,pair_address,graduated,market_cap_usd,liquidity_usd
    FROM tokens ORDER BY COALESCE(market_cap_usd,0) DESC,last_seen_ms DESC LIMIT 24`).all<TokenMeta>();

  const candidates: string[] = [];
  for (const item of discovery.slice(0, DISCOVERY_LIMIT)) {
    const token = tokenAddress(item);
    if (token && !candidates.includes(token)) candidates.push(token);
  }
  for (const row of existing.results ?? []) if (!candidates.includes(row.address)) candidates.push(row.address);

  const now = Date.now();
  let snapshots = 0;
  let directEligible = 0;
  let capEligible = 0;
  let chartAttempts = 0;
  let chartHits = 0;
  let lastSkipReason = "no-candidates";

  for (const token of candidates) {
    if (snapshots >= SNAPSHOT_LIMIT) break;

    const item = rankedByToken.get(token.toLowerCase());
    const meta = await env.DB.prepare(`SELECT address,total_supply,decimals,quote_token,pair_address,graduated,market_cap_usd,liquidity_usd FROM tokens WHERE address=?`).bind(token).first<TokenMeta>();
    const decimals = Math.max(0, decimalsValue(item, Number(meta?.decimals || 18)));
    let cap = item ? marketCap(item, decimals) : Number(meta?.market_cap_usd || 0);
    let px = item ? price(item) : 0;
    const supply = totalSupply(item, meta ?? null, decimals);
    let liq = item ? liquidity(item) : Number(meta?.liquidity_usd || 0);
    let vol = item ? volume5m(item) : 0;
    let hold = item ? holders(item) : 0;

    if (!(px > 0) && cap > 0 && supply > 0) px = cap / supply;
    if (cap >= MIN_MARKET_CAP_USD && px > 0) directEligible++;

    if ((cap < MIN_MARKET_CAP_USD || !(px > 0)) && chartAttempts < MAX_CHART_ATTEMPTS) {
      chartAttempts++;
      const chart = await fetchChart(token);
      if (chart.length) {
        chartHits++;
        const last = chart[chart.length - 1];
        if (!(cap > 0)) cap = last.c;
        if (!(px > 0) && supply > 0) px = cap / supply;
        if (!(vol > 0)) vol = last.v;
      }
    }

    if (cap >= MIN_MARKET_CAP_USD) capEligible++;
    if (cap < MIN_MARKET_CAP_USD) {
      lastSkipReason = `below-$90k:${Math.round(cap)}`;
      continue;
    }
    if (!(px > 0)) {
      lastSkipReason = "missing-price";
      continue;
    }

    const quoteToken = quote(item ?? {}) || meta?.quote_token || "NADFUN";
    const pairAddress = pair(item ?? {}) || meta?.pair_address || null;
    const graduatedFlag = item ? graduated(item) : Number(meta?.graduated || 0);

    await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      token,
      now,
      px,
      cap,
      liq,
      vol,
      0,
      0,
      hold,
      quoteToken,
      0,
      0,
      Number(toBlock)
    ).run();

    await env.DB.prepare(`UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=?,quote_token=COALESCE(?,quote_token),pair_address=COALESCE(?,pair_address),graduated=MAX(graduated,?) WHERE address=?`).bind(
      cap,
      liq,
      now,
      quoteToken,
      pairAddress,
      graduatedFlag,
      token
    ).run();

    snapshots++;
    lastSkipReason = "snapshot-written";
  }

  const runtimeRaw = await env.CIEL_STATE.get("ciel_runtime_state");
  let runtime: Record<string, unknown> = {};
  try { runtime = runtimeRaw ? JSON.parse(runtimeRaw) as Record<string, unknown> : {}; } catch {}
  runtime.lastIndexerDiscoveryCount = discovery.length;
  runtime.lastIndexerValidAddressCount = validAddressCount;
  runtime.lastIndexerCandidateCount = candidates.length;
  runtime.lastIndexerDirectEligible = directEligible;
  runtime.lastIndexerCapEligible = capEligible;
  runtime.lastIndexerChartAttempts = chartAttempts;
  runtime.lastIndexerChartHits = chartHits;
  runtime.lastIndexerSkipReason = lastSkipReason;
  await env.CIEL_STATE.put("ciel_runtime_state", JSON.stringify(runtime));

  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({
    nextBlock: (toBlock + 1n).toString(),
    latestBlock: latest.toString(),
    lastSnapshotCount: snapshots,
    lastRunMs: now
  } satisfies IndexerState));

  return {
    fromBlock,
    toBlock,
    creates: creates.length,
    buys: 0,
    sells: 0,
    graduates: 0,
    syncs: 0,
    snapshots,
    nextBlock: toBlock + 1n
  };
}
