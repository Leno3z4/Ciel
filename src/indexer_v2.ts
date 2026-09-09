import { decodeEventLog, parseAbiItem } from "viem";
import { NADFUN_BONDING, WMON, LVMON, publicClient } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const buyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const sellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const snipingPenaltyEvent = parseAbiItem("event SnipingPenalty(address indexed token,address indexed buyer,uint256 snipingFee,uint256 penaltyBps)");
const bondingEvents = [createEvent, buyEvent, sellEvent, syncEvent, graduateEvent, snipingPenaltyEvent] as const;

type IndexEnv = { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA?: R2Bucket; NAD_RPC_URL?: string };
type TokenRecord = { token_info?: Record<string, unknown>; market_info?: Record<string, unknown>; percent?: number | string; [key: string]: unknown };
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };
type EventStats = { buys: number; sells: number; buyQuoteWei: bigint; sellQuoteWei: bigint; syncs: number; graduates: number; penalties: number };

const INDEXER_STATE_KEY = "indexer_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const RANKING_FETCH_TS_KEY = "nadfun_market_ranking_fetch_ms";
const MARKET_LIMIT = 50;
const SNAPSHOT_LIMIT = 12;
const MIN_MARKET_CAP_USD = 90_000;
const NADFUN_TOTAL_SUPPLY = 1_000_000_000;
const LOG_RANGE_BLOCKS = 100;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const API_BASE = "https://api.nadapp.net";
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
const WMON_ADDRESS = WMON.toLowerCase();
const LVMON_ADDRESS = LVMON.toLowerCase();

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function address(value: unknown): string | null {
  const text = str(value);
  return text && /^0x[a-fA-F0-9]{40}$/.test(text) ? text : null;
}

function objectValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
  return null;
}

function nestedNumber(item: TokenRecord, tokenKeys: string[], marketKeys: string[]): number {
  return num(objectValue(item.market_info, marketKeys)) || num(objectValue(item.token_info, tokenKeys));
}

function tokenAddress(item: TokenRecord): string | null {
  return address(objectValue(item.token_info, ["token_id", "token_address", "tokenAddress"])) || address(objectValue(item.market_info, ["token_id", "token_address", "tokenAddress"]));
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
  } catch {
    return null;
  }
}

async function fetchMarketCapFeed(env: IndexEnv): Promise<TokenRecord[]> {
  const cached = await env.CIEL_STATE.get(RANKING_CACHE_KEY);
  if (cached) {
    try {
      const cachedTokens = extractTokens(JSON.parse(cached));
      if (cachedTokens.length) {
        const fetchedAt = Number(await env.CIEL_STATE.get(RANKING_FETCH_TS_KEY) || "0");
        if (!fetchedAt || Date.now() - fetchedAt < DISCOVERY_REFRESH_MS) return cachedTokens;
      }
    } catch {}
  }

  try {
    const response = await fetch(`${API_BASE}/order/market_cap?page=1&limit=${MARKET_LIMIT}&is_nsfw=false`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 600 }
    });
    if (!response.ok) throw new Error(`market-cap HTTP ${response.status}`);
    const tokens = extractTokens(decodeApiBody(await response.text()));
    if (tokens.length) {
      await env.CIEL_STATE.put(RANKING_CACHE_KEY, JSON.stringify(tokens), { expirationTtl: 3600 });
      await env.CIEL_STATE.put(RANKING_FETCH_TS_KEY, String(Date.now()), { expirationTtl: 3600 });
    }
    return tokens;
  } catch (error) {
    console.error(`NadFun market-cap feed failed: ${String(error).slice(0, 500)}`);
    if (cached) {
      try { return extractTokens(JSON.parse(cached)); } catch {}
    }
    return [];
  }
}

function estimateMonUsd(tokens: TokenRecord[]): number {
  const estimates: number[] = [];
  for (const item of tokens) {
    const tokenInMon = nestedNumber(item, [], ["price", "token_price"]);
    const tokenUsd = nestedNumber(item, ["price_usd"], ["price_usd"]);
    if (tokenInMon > 0 && tokenUsd > 0) {
      const ratio = tokenUsd / tokenInMon;
      if (ratio > 0.01 && ratio < 1_000) estimates.push(ratio);
    }
    const direct = nestedNumber(item, [], ["mon_price_usd", "native_price_usd", "quote_price_usd"]);
    if (direct > 0) estimates.push(direct);
  }
  if (!estimates.length) return 0;
  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)] || 0;
}

function totalSupply(item: TokenRecord): number {
  const raw = objectValue(item.token_info, ["total_supply", "totalSupply", "supply", "circulating_supply", "circulatingSupply"]);
  const decimals = Math.max(0, Math.floor(num(objectValue(item.token_info, ["decimals", "token_decimals", "tokenDecimals"])) || 18));
  const value = num(raw);
  if (value > 0) return value >= 1e15 ? value / 10 ** decimals : value;

  // NadFun-created coins use a fixed 1B token supply. The market-cap feed
  // returns price/supply data under market_info rather than a total_supply field.
  return NADFUN_TOTAL_SUPPLY;
}

function marketCap(item: TokenRecord): number {
  const direct = nestedNumber(item, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"], ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"]);
  if (direct > 0) return direct;
  const priceUsd = nestedNumber(item, ["price_usd", "priceUsd"], ["price_usd", "priceUsd"]);
  const supply = totalSupply(item);
  return priceUsd > 0 && supply > 0 ? priceUsd * supply : 0;
}

function priceUsd(item: TokenRecord): number {
  return nestedNumber(item, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"], ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"]);
}

function liquidityUsd(item: TokenRecord, monUsd: number): number {
  const direct = nestedNumber(item, ["liquidity_usd", "liquidityUsd"], ["liquidity_usd", "liquidityUsd"]);
  if (direct > 0) return direct;
  const reserveNative = num(objectValue(item.market_info, ["reserve_native"]));
  return reserveNative > 0 && monUsd > 0 ? reserveNative / 1e18 * monUsd : 0;
}

function holders(item: TokenRecord): number { return nestedNumber(item, ["holder_count", "holderCount", "holders"], ["holder_count", "holderCount", "holders"]); }
function symbol(item: TokenRecord): string | null { return str(objectValue(item.token_info, ["symbol"])); }
function name(item: TokenRecord): string | null { return str(objectValue(item.token_info, ["name"])); }
function quoteToken(item: TokenRecord): string | null { return address(objectValue(item.market_info, ["quote_token", "quoteToken"])) || address(objectValue(item.token_info, ["quote_token", "quoteToken"])); }
function pairAddress(item: TokenRecord): string | null { return address(objectValue(item.market_info, ["pair_address", "pairAddress", "pair"])) || address(objectValue(item.token_info, ["pair_address", "pairAddress", "pair"])); }
function graduated(item: TokenRecord): number { return objectValue(item.token_info, ["is_graduated", "isGraduated"]) === true || String(objectValue(item.market_info, ["market_type", "marketType"]) || "").toUpperCase() === "DEX" ? 1 : 0; }

async function saveToken(env: IndexEnv, token: string, item?: TokenRecord, createdAtBlock?: bigint, monUsd = 0): Promise<void> {
  const now = Date.now();
  const cap = item ? marketCap(item) : 0;
  const liq = item ? liquidityUsd(item, monUsd) : 0;
  await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET
      symbol=COALESCE(excluded.symbol,tokens.symbol),
      name=COALESCE(excluded.name,tokens.name),
      market_cap_usd=CASE WHEN excluded.market_cap_usd>0 THEN excluded.market_cap_usd ELSE tokens.market_cap_usd END,
      liquidity_usd=CASE WHEN excluded.liquidity_usd>0 THEN excluded.liquidity_usd ELSE tokens.liquidity_usd END,
      last_seen_ms=excluded.last_seen_ms,
      total_supply=COALESCE(excluded.total_supply,tokens.total_supply),
      decimals=excluded.decimals,
      quote_token=COALESCE(excluded.quote_token,tokens.quote_token),
      pair_address=COALESCE(excluded.pair_address,tokens.pair_address),
      graduated=MAX(tokens.graduated,excluded.graduated),
      created_at_block=COALESCE(tokens.created_at_block,excluded.created_at_block)`).bind(
    token,
    item ? symbol(item) : null,
    item ? name(item) : null,
    cap,
    liq,
    now,
    now,
    item ? objectValue(item.token_info, ["total_supply", "totalSupply", "supply"]) : null,
    Math.max(0, Math.floor(num(objectValue(item?.token_info, ["decimals", "token_decimals", "tokenDecimals"])) || 18)),
    item ? quoteToken(item) : null,
    item ? pairAddress(item) : null,
    item ? graduated(item) : 0,
    createdAtBlock !== undefined ? Number(createdAtBlock) : null
  ).run();
}

function addEventStats(map: Map<string, EventStats>, token: string): EventStats {
  const key = token.toLowerCase();
  const current = map.get(key) || { buys: 0, sells: 0, buyQuoteWei: 0n, sellQuoteWei: 0n, syncs: 0, graduates: 0, penalties: 0 };
  map.set(key, current);
  return current;
}

function parseBondingLogs(logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[]; blockNumber: bigint }[]): { creates: Array<{ token: string; creator: string | null; pair: string | null; quoteToken: string | null; name: string | null; symbol: string | null; blockNumber: bigint }>; stats: Map<string, EventStats> } {
  const creates: Array<{ token: string; creator: string | null; pair: string | null; quoteToken: string | null; name: string | null; symbol: string | null; blockNumber: bigint }> = [];
  const stats = new Map<string, EventStats>();
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: bondingEvents, data: log.data, topics: log.topics });
      const args = decoded.args as Record<string, unknown>;
      const token = address(args.token);
      if (!token) continue;
      const eventName = String(decoded.eventName);
      if (eventName === "Create") {
        creates.push({ token, creator: address(args.creator), pair: address(args.pair), quoteToken: address(args.quoteToken), name: str(args.name), symbol: str(args.symbol), blockNumber: log.blockNumber });
      } else if (eventName === "Buy") {
        const s = addEventStats(stats, token); s.buys++; s.buyQuoteWei += BigInt(args.quoteIn as bigint || 0n);
      } else if (eventName === "Sell") {
        const s = addEventStats(stats, token); s.sells++; s.sellQuoteWei += BigInt(args.quoteOut as bigint || 0n);
      } else if (eventName === "Sync") {
        addEventStats(stats, token).syncs++;
      } else if (eventName === "Graduate") {
        addEventStats(stats, token).graduates++;
      } else if (eventName === "SnipingPenalty") {
        addEventStats(stats, token).penalties++;
      }
    } catch (error) {
      console.error(`NadFun event decode failed: ${String(error).slice(0, 300)}`);
    }
  }
  return { creates, stats };
}

export async function indexNadFun(env: IndexEnv, maxBlocks = LOG_RANGE_BLOCKS): Promise<{ fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; snapshots: number; nextBlock: bigint } | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const rawState = await env.CIEL_STATE.get(INDEXER_STATE_KEY);
  const state = rawState ? JSON.parse(rawState) as IndexerState : null;
  const cursor = state?.nextBlock ?? await env.CIEL_STATE.get("indexer_next_block");
  let fromBlock = cursor ? BigInt(cursor) : (latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n);
  if (latest - fromBlock > MAX_ACCEPTABLE_LAG_BLOCKS) fromBlock = latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n;
  if (fromBlock > latest) return null;
  const blockCount = Math.max(1, Math.min(Math.floor(maxBlocks), LOG_RANGE_BLOCKS));
  const toBlock = fromBlock + BigInt(blockCount - 1) > latest ? latest : fromBlock + BigInt(blockCount - 1);

  const [logs, discovery] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, fromBlock, toBlock }),
    fetchMarketCapFeed(env)
  ]);
  const parsed = parseBondingLogs(logs);

  for (const item of parsed.creates) {
    await saveToken(env, item.token, { token_info: { token_id: item.token, symbol: item.symbol, name: item.name, is_graduated: false }, market_info: { quote_token: item.quoteToken, pair_address: item.pair } }, item.blockNumber);
  }
  for (const [tokenKey, stats] of parsed.stats) {
    if (stats.graduates > 0) await env.DB.prepare("UPDATE tokens SET graduated=1,last_seen_ms=? WHERE lower(address)=?").bind(Date.now(), tokenKey).run();
  }

  const monUsd = estimateMonUsd(discovery);
  if (monUsd > 0) await env.CIEL_STATE.put("mon_usd", String(monUsd), { expirationTtl: 3600 });

  const rankedByToken = new Map<string, TokenRecord>();
  let validAddressCount = 0;
  for (const item of discovery) {
    const token = tokenAddress(item);
    if (!token) continue;
    rankedByToken.set(token.toLowerCase(), item);
    validAddressCount++;
    await saveToken(env, token, item, undefined, monUsd);
  }

  let snapshots = 0;
  let directEligible = 0;
  let capEligible = 0;
  let lastSkipReason = discovery.length ? "no-qualifying-cap" : "market-feed-empty";
  const orderedCandidates = Array.from(rankedByToken.entries()).sort((a, b) => marketCap(b[1]) - marketCap(a[1]));
  for (const [tokenKey, item] of orderedCandidates) {
    if (snapshots >= SNAPSHOT_LIMIT) break;
    const cap = marketCap(item);
    if (cap >= MIN_MARKET_CAP_USD) directEligible++;
    if (cap >= MIN_MARKET_CAP_USD) capEligible++;
    if (cap < MIN_MARKET_CAP_USD || !(priceUsd(item) > 0)) continue;
    const wrote = await writeSnapshot(env, tokenKey, item, parsed.stats.get(tokenKey) || { buys: 0, sells: 0, buyQuoteWei: 0n, sellQuoteWei: 0n, syncs: 0, graduates: 0, penalties: 0 }, monUsd, toBlock);
    if (wrote) { snapshots++; lastSkipReason = "snapshot-written"; }
  }

  const runtimeRaw = await env.CIEL_STATE.get("ciel_runtime_state");
  let runtime: Record<string, unknown> = {};
  try { runtime = runtimeRaw ? JSON.parse(runtimeRaw) as Record<string, unknown> : {}; } catch {}
  runtime.lastIndexerDiscoveryCount = discovery.length;
  runtime.lastIndexerValidAddressCount = validAddressCount;
  runtime.lastIndexerCandidateCount = orderedCandidates.length;
  runtime.lastIndexerDirectEligible = directEligible;
  runtime.lastIndexerCapEligible = capEligible;
  runtime.lastIndexerChartAttempts = 0;
  runtime.lastIndexerChartHits = 0;
  runtime.lastIndexerSkipReason = lastSkipReason;
  runtime.lastIndexerBuyEvents = Array.from(parsed.stats.values()).reduce((n, s) => n + s.buys, 0);
  runtime.lastIndexerSellEvents = Array.from(parsed.stats.values()).reduce((n, s) => n + s.sells, 0);
  runtime.lastIndexerSyncEvents = Array.from(parsed.stats.values()).reduce((n, s) => n + s.syncs, 0);
  runtime.lastIndexerGraduateEvents = Array.from(parsed.stats.values()).reduce((n, s) => n + s.graduates, 0);
  runtime.lastIndexerPenaltyEvents = Array.from(parsed.stats.values()).reduce((n, s) => n + s.penalties, 0);
  runtime.lastIndexerMarketFeedAt = Date.now();
  runtime.lastIndexerMonUsd = monUsd || null;
  await env.CIEL_STATE.put("ciel_runtime_state", JSON.stringify(runtime));
  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({ nextBlock: (toBlock + 1n).toString(), latestBlock: latest.toString(), lastSnapshotCount: snapshots, lastRunMs: Date.now() } satisfies IndexerState));

  return {
    fromBlock,
    toBlock,
    creates: parsed.creates.length,
    buys: Array.from(parsed.stats.values()).reduce((n, s) => n + s.buys, 0),
    sells: Array.from(parsed.stats.values()).reduce((n, s) => n + s.sells, 0),
    graduates: Array.from(parsed.stats.values()).reduce((n, s) => n + s.graduates, 0),
    syncs: Array.from(parsed.stats.values()).reduce((n, s) => n + s.syncs, 0),
    snapshots,
    nextBlock: toBlock + 1n
  };
}

async function writeSnapshot(env: IndexEnv, token: string, item: TokenRecord, stats: EventStats, monUsd: number, sourceBlock: bigint): Promise<boolean> {
  const cap = marketCap(item);
  const px = priceUsd(item);
  const liq = liquidityUsd(item, monUsd);
  if (!(cap >= MIN_MARKET_CAP_USD) || !(px > 0)) return false;
  const quoteUsdMultiplier = monUsd > 0 ? monUsd : 0;
  const buyVolumeUsd = Number(stats.buyQuoteWei) / 1e18 * quoteUsdMultiplier;
  const sellVolumeUsd = Number(stats.sellQuoteWei) / 1e18 * quoteUsdMultiplier;
  await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    token,
    Date.now(),
    px,
    cap,
    liq,
    Math.max(0, buyVolumeUsd + sellVolumeUsd),
    stats.buys,
    stats.sells,
    holders(item),
    quoteToken(item),
    Math.max(0, buyVolumeUsd),
    Math.max(0, sellVolumeUsd),
    Number(sourceBlock)
  ).run();
  await env.DB.prepare(`UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=?,quote_token=COALESCE(?,quote_token),pair_address=COALESCE(?,pair_address),graduated=MAX(graduated,?) WHERE address=?`).bind(
    cap, liq, Date.now(), quoteToken(item), pairAddress(item), graduated(item), token
  ).run();
  return true;
}
