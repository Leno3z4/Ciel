import { parseAbiItem } from "viem";
import { NADFUN_BONDING, WMON, LVMON, publicClient } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const buyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const sellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const snipingPenaltyEvent = parseAbiItem("event SnipingPenalty(address indexed token,address indexed buyer,uint256 snipingFee,uint256 penaltyBps)");

type IndexEnv = { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA?: R2Bucket; NAD_RPC_URL?: string };
type TokenRecord = { token_info?: Record<string, unknown>; market_info?: Record<string, unknown>; percent?: number | string; [key: string]: unknown };
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };
type EventStats = { buys: number; sells: number; buyQuoteWei: bigint; sellQuoteWei: bigint; syncs: number; graduates: number; penalties: number };

const INDEXER_STATE_KEY = "indexer_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const MARKET_LIMIT = 50;
const SNAPSHOT_LIMIT = 12;
const MIN_MARKET_CAP_USD = 90_000;
const LOG_RANGE_BLOCKS = 600;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const API_BASE = "https://api.nadapp.net";
const DISCOVERY_REFRESH_MS = 10 * 60 * 1000;
const MAX_CACHE_AGE_MS = 30 * 60 * 1000;
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

function tokenAddress(item: TokenRecord): string | null {
  return address(objectValue(item.token_info, ["token_id", "token_address", "tokenAddress"])) || address(objectValue(item.market_info, ["token_id", "token_address", "tokenAddress"]));
}

function readMarketNumber(item: TokenRecord, keys: string[]): number {
  return num(objectValue(item.market_info, keys));
}

function readTokenNumber(item: TokenRecord, keys: string[]): number {
  return num(objectValue(item.token_info, keys));
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

function decode(raw: string): unknown | null {
  const text = raw.trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "string") return parsed;
  } catch {}
  try {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
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
      if (cachedTokens.length) return cachedTokens;
    } catch {}
  }
  try {
    const response = await fetch(`${API_BASE}/order/market_cap?page=1&limit=${MARKET_LIMIT}&is_nsfw=false`, {
      headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" },
      cf: { cacheTtl: 600 }
    });
    if (!response.ok) throw new Error(`market-cap HTTP ${response.status}`);
    const body = await response.text();
    const tokens = extractTokens(decode(body));
    if (tokens.length) {
      await env.CIEL_STATE.put(RANKING_CACHE_KEY, JSON.stringify(tokens), { expirationTtl: 3600 });
      await env.CIEL_STATE.put("nadfun_market_ranking_fetch_ms", String(Date.now()), { expirationTtl: 3600 });
    }
    return tokens;
  } catch (error) {
    console.error(`NadFun market-cap feed failed: ${String(error).slice(0, 500)}`);
    return [];
  }
}

function estimateMonUsd(tokens: TokenRecord[]): number {
  const estimates: number[] = [];
  for (const item of tokens) {
    const monPrice = readMarketNumber(item, ["price", "token_price"]);
    const usdPrice = readMarketNumber(item, ["price_usd"]);
    if (monPrice > 0 && usdPrice > 0) {
      const ratio = usdPrice / monPrice;
      if (ratio > 0.01 && ratio < 1_000) estimates.push(ratio);
    }
    const direct = readMarketNumber(item, ["mon_price_usd", "native_price_usd", "quote_price_usd"]);
    if (direct > 0) estimates.push(direct);
  }
  if (!estimates.length) return 0;
  estimates.sort((a, b) => a - b);
  return estimates[Math.floor(estimates.length / 2)] || 0;
}

function totalSupply(item: TokenRecord): number {
  const raw = objectValue(item.token_info, ["total_supply", "totalSupply", "supply", "circulating_supply", "circulatingSupply"]);
  const decimals = Math.max(0, Math.floor(readTokenNumber(item, ["decimals", "token_decimals", "tokenDecimals"]) || 18));
  const value = num(raw);
  return value > 0 ? (value >= 1e15 ? value / 10 ** decimals : value) : 0;
}

function marketCap(item: TokenRecord): number {
  const direct = readMarketNumber(item, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"]);
  if (direct > 0) return direct;
  const priceUsd = readMarketNumber(item, ["price_usd", "priceUsd"]);
  const supply = totalSupply(item);
  return priceUsd > 0 && supply > 0 ? priceUsd * supply : 0;
}

function priceUsd(item: TokenRecord): number {
  return readMarketNumber(item, ["price_usd", "priceUsd", "token_price_usd", "tokenPriceUsd"]);
}

function liquidityUsd(item: TokenRecord, monUsd: number): number {
  const direct = readMarketNumber(item, ["liquidity_usd", "liquidityUsd"]);
  if (direct > 0) return direct;
  const reserveNative = num(objectValue(item.market_info, ["reserve_native"]));
  return reserveNative > 0 && monUsd > 0 ? (reserveNative / 1e18) * monUsd : 0;
}

function holders(item: TokenRecord): number {
  return readMarketNumber(item, ["holder_count", "holderCount", "holders"]);
}

function symbol(item: TokenRecord): string | null { return str(objectValue(item.token_info, ["symbol"])); }
function name(item: TokenRecord): string | null { return str(objectValue(item.token_info, ["name"])); }
function quoteToken(item: TokenRecord): string | null { return address(objectValue(item.market_info, ["quote_token", "quoteToken"])) || address(objectValue(item.token_info, ["quote_token", "quoteToken"])); }
function pairAddress(item: TokenRecord): string | null { return address(objectValue(item.market_info, ["pair_address", "pairAddress", "pair"])) || address(objectValue(item.token_info, ["pair_address", "pairAddress", "pair"])); }
function graduated(item: TokenRecord): number { return objectValue(item.token_info, ["is_graduated", "isGraduated"]) === true || String(objectValue(item.market_info, ["market_type", "marketType"]) || "").toUpperCase() === "DEX" ? 1 : 0; }

async function saveToken(env: IndexEnv, token: string, item: TokenRecord | undefined, createdAtBlock?: bigint): Promise<void> {
  const now = Date.now();
  const cap = item ? marketCap(item) : 0;
  const liq = item ? liquidityUsd(item, 0) : 0;
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
    Math.max(0, Math.floor(readTokenNumber(item || {}, ["decimals", "token_decimals", "tokenDecimals"]) || 18)),
    item ? quoteToken(item) : null,
    item ? pairAddress(item) : null,
    item ? graduated(item) : 0,
    createdAtBlock !== undefined ? Number(createdAtBlock) : null
  ).run();
}

function emptyStats(): EventStats { return { buys: 0, sells: 0, buyQuoteWei: 0n, sellQuoteWei: 0n, syncs: 0, graduates: 0, penalties: 0 }; }

async function loadEventStats(client: ReturnType<typeof publicClient>, fromBlock: bigint, toBlock: bigint): Promise<Map<string, EventStats>> {
  const result = new Map<string, EventStats>();
  const add = (token: string): EventStats => { const key = token.toLowerCase(); const current = result.get(key) || emptyStats(); result.set(key, current); return current; };
  const [buys, sells, syncs, graduates, penalties] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: buyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: sellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: snipingPenaltyEvent, fromBlock, toBlock })
  ]);
  for (const log of buys) { if (!log.args.token) continue; const s = add(log.args.token); s.buys++; s.buyQuoteWei += BigInt(log.args.quoteIn ?? 0); }
  for (const log of sells) { if (!log.args.token) continue; const s = add(log.args.token); s.sells++; s.sellQuoteWei += BigInt(log.args.quoteOut ?? 0); }
  for (const log of syncs) if (log.args.token) add(log.args.token).syncs++;
  for (const log of graduates) if (log.args.token) add(log.args.token).graduates++;
  for (const log of penalties) if (log.args.token) add(log.args.token).penalties++;
  return result;
}

async function writeSnapshot(env: IndexEnv, token: string, item: TokenRecord, stats: EventStats, monUsd: number, sourceBlock: bigint): Promise<boolean> {
  const cap = marketCap(item);
  const px = priceUsd(item);
  const liq = liquidityUsd(item, monUsd);
  if (!(cap >= MIN_MARKET_CAP_USD) || !(px > 0)) return false;
  const activityUsd = Number(stats.buyQuoteWei + stats.sellQuoteWei) / 1e18 * monUsd;
  const qToken = quoteToken(item);
  await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    token,
    Date.now(),
    px,
    cap,
    liq,
    Math.max(0, activityUsd),
    stats.buys,
    stats.sells,
    holders(item),
    qToken,
    Math.max(0, Number(stats.buyQuoteWei) / 1e18 * monUsd),
    Math.max(0, Number(stats.sellQuoteWei) / 1e18 * monUsd),
    Number(sourceBlock)
  ).run();
  await env.DB.prepare(`UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=?,quote_token=COALESCE(?,quote_token),pair_address=COALESCE(?,pair_address),graduated=MAX(graduated,?) WHERE address=?`).bind(
    cap, liq, Date.now(), qToken, pairAddress(item), graduated(item), token
  ).run();
  return true;
}

export async function indexNadFun(env: IndexEnv, maxBlocks = LOG_RANGE_BLOCKS) {
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

  const [creates, eventStats, discovery] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    loadEventStats(client, fromBlock, toBlock),
    fetchMarketCapFeed(env)
  ]);

  for (const log of creates) {
    if (!log.args.token) continue;
    await saveToken(env, log.args.token, { token_info: { token_id: log.args.token, symbol: log.args.symbol, name: log.args.name, is_graduated: false }, market_info: { quote_token: log.args.quoteToken, pair_address: log.args.pair } }, log.blockNumber);
  }

  for (const [tokenKey, stats] of eventStats) {
    if (stats.graduates > 0) {
      await env.DB.prepare("UPDATE tokens SET graduated=1,last_seen_ms=?,pair_address=COALESCE(pair_address,?) WHERE lower(address)=?").bind(Date.now(), null, tokenKey).run();
    }
  }

  const monUsd = (() => {
    const estimated = estimateMonUsd(discovery);
    if (estimated > 0) return estimated;
    return Number(0);
  })();
  if (monUsd > 0) {
    await env.CIEL_STATE.put("mon_usd", String(monUsd), { expirationTtl: 3600 });
  }

  const rankedByToken = new Map<string, TokenRecord>();
  let validAddressCount = 0;
  for (const item of discovery) {
    const token = tokenAddress(item);
    if (!token) continue;
    rankedByToken.set(token.toLowerCase(), item);
    validAddressCount++;
    await saveToken(env, token, item);
  }

  const candidates = Array.from(rankedByToken.keys());
  let snapshots = 0;
  let directEligible = 0;
  let capEligible = 0;
  let skipReason = discovery.length ? "no-qualifying-cap" : "market-feed-empty";

  for (const tokenKey of candidates) {
    if (snapshots >= SNAPSHOT_LIMIT) break;
    const item = rankedByToken.get(tokenKey)!;
    const cap = marketCap(item);
    if (cap >= MIN_MARKET_CAP_USD) directEligible++;
    if (cap >= MIN_MARKET_CAP_USD) capEligible++;
    const ok = await writeSnapshot(env, tokenKey, item, eventStats.get(tokenKey) || emptyStats(), monUsd, toBlock);
    if (ok) { snapshots++; skipReason = "snapshot-written"; }
  }

  const runtimeRaw = await env.CIEL_STATE.get("ciel_runtime_state");
  let runtime: Record<string, unknown> = {};
  try { runtime = runtimeRaw ? JSON.parse(runtimeRaw) as Record<string, unknown> : {}; } catch {}
  runtime.lastIndexerDiscoveryCount = discovery.length;
  runtime.lastIndexerValidAddressCount = validAddressCount;
  runtime.lastIndexerCandidateCount = candidates.length;
  runtime.lastIndexerDirectEligible = directEligible;
  runtime.lastIndexerCapEligible = capEligible;
  runtime.lastIndexerChartAttempts = 0;
  runtime.lastIndexerChartHits = 0;
  runtime.lastIndexerSkipReason = skipReason;
  runtime.lastIndexerBuyEvents = Array.from(eventStats.values()).reduce((n, s) => n + s.buys, 0);
  runtime.lastIndexerSellEvents = Array.from(eventStats.values()).reduce((n, s) => n + s.sells, 0);
  runtime.lastIndexerSyncEvents = Array.from(eventStats.values()).reduce((n, s) => n + s.syncs, 0);
  runtime.lastIndexerGraduateEvents = Array.from(eventStats.values()).reduce((n, s) => n + s.graduates, 0);
  runtime.lastIndexerMarketFeedAt = Date.now();
  await env.CIEL_STATE.put("ciel_runtime_state", JSON.stringify(runtime));
  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({ nextBlock: (toBlock + 1n).toString(), latestBlock: latest.toString(), lastSnapshotCount: snapshots, lastRunMs: Date.now() } satisfies IndexerState));

  return {
    fromBlock,
    toBlock,
    creates: creates.length,
    buys: Array.from(eventStats.values()).reduce((n, s) => n + s.buys, 0),
    sells: Array.from(eventStats.values()).reduce((n, s) => n + s.sells, 0),
    graduates: Array.from(eventStats.values()).reduce((n, s) => n + s.graduates, 0),
    syncs: Array.from(eventStats.values()).reduce((n, s) => n + s.syncs, 0),
    snapshots,
    nextBlock: toBlock + 1n
  };
}
