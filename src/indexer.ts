import { parseAbiItem, type Address } from "viem";
import { NADFUN_BONDING, NADFUN_FACTORY, NADFUN_ROUTER, publicClient, WMON, LVMON } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const bondingBuyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const bondingSellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const routerBuyEvent = parseAbiItem("event Buy(address indexed buyer,address indexed token,uint256 amountIn,uint256 amountOut,bool graduated)");
const routerSellEvent = parseAbiItem("event Sell(address indexed seller,address indexed token,uint256 amountIn,uint256 amountOut,bool graduated)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");
const snipingEvent = parseAbiItem("event SnipingPenalty(address indexed token,uint256 penaltyBps)");
const pairCreatedEvent = parseAbiItem("event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)");

const tokenMetaAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }
] as const;

const factoryAbi = [
  { type: "function", name: "allPairsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allPairs", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] }
] as const;

const factoryPairAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }
] as const;

export interface IndexResult { fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; snapshots: number; nextBlock: bigint; }
type IndexEnv = { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA?: R2Bucket; NAD_RPC_URL?: string };

type NadFunMarketInfo = Record<string, unknown>;
type NadFunToken = { token_info?: Record<string, unknown>; market_info?: NadFunMarketInfo; percent?: number | string };
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };

const INDEXER_STATE_KEY = "indexer_state";
const RPC_LOG_RANGE_BLOCKS = 100;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const ESTABLISHED_TOKEN_LIMIT = 12;
const FACTORY_BOOTSTRAP_PAIR_LIMIT = 8;
const NADFUN_MARKET_LIMIT = 50;
const MIN_MARKET_CAP_USD = 90_000;
const NADFUN_API_BASE = "https://api.nadapp.net";

function asNumber(value: unknown): number { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; }
function asString(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function rawToUnits(value: bigint, decimals: number): number { return Number(value) / 10 ** decimals; }
function apiSupplyToUnits(value: unknown, decimals: number): number {
  const n = asNumber(value);
  if (!(n > 0)) return 0;
  return n >= 1e15 ? n / 10 ** decimals : n;
}

function decodeBase64Json(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  try {
    const binary = atob(trimmed);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

async function fetchNadFunMarketRanking(): Promise<NadFunToken[]> {
  const url = `${NADFUN_API_BASE}/order/market_cap?page=1&limit=${NADFUN_MARKET_LIMIT}&is_nsfw=false`;
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun-Indexer/1.0" }, cf: { cacheTtl: 15 } });
  if (!response.ok) throw new Error(`NadFun market ranking HTTP ${response.status}`);
  const decoded = decodeBase64Json(await response.text()) as { tokens?: NadFunToken[] } | null;
  if (!decoded || !Array.isArray(decoded.tokens)) throw new Error("NadFun market ranking response was not valid token data");
  return decoded.tokens;
}

function tokenId(item: NadFunToken): string | null { return asString(item.token_info?.token_id) || asString(item.token_info?.address); }
function tokenSymbol(item: NadFunToken): string | null { return asString(item.token_info?.symbol); }
function tokenName(item: NadFunToken): string | null { return asString(item.token_info?.name); }
function tokenQuote(item: NadFunToken): string | null { return asString(item.market_info?.quote_id) || asString(item.market_info?.quote_token) || asString(item.token_info?.quote_token); }
function tokenPair(item: NadFunToken): string | null { return asString(item.market_info?.market_id) || asString(item.market_info?.pair_address) || asString(item.token_info?.pair_address); }
function tokenGraduated(item: NadFunToken): number {
  const info = item.market_info?.market_type;
  if (typeof info === "string" && info.toUpperCase().includes("DEX")) return 1;
  return item.token_info?.is_graduated === true ? 1 : 0;
}
function tokenMarketCap(item: NadFunToken, decimals: number): number {
  const direct = asNumber(item.market_info?.market_cap_usd) || asNumber(item.market_info?.market_cap) || asNumber(item.token_info?.market_cap_usd) || asNumber(item.token_info?.market_cap);
  if (direct > 0) return direct;
  const priceUsd = asNumber(item.market_info?.price_usd) || asNumber(item.market_info?.price);
  const supply = apiSupplyToUnits(item.market_info?.total_supply ?? item.token_info?.total_supply, decimals);
  return priceUsd > 0 && supply > 0 ? priceUsd * supply : 0;
}
function tokenPriceUsd(item: NadFunToken): number { return asNumber(item.market_info?.price_usd) || asNumber(item.market_info?.price); }
function tokenQuotePriceUsd(item: NadFunToken): number {
  return asNumber(item.market_info?.quote_price_usd) || asNumber(item.market_info?.quote_price) || asNumber(item.market_info?.native_price_usd) || asNumber(item.market_info?.mon_price_usd);
}
function tokenLiquidityUsd(item: NadFunToken): number {
  const direct = asNumber(item.market_info?.liquidity_usd) || asNumber(item.market_info?.liquidity);
  if (direct > 0) return direct;
  const reserveNative = asNumber(item.market_info?.reserve_native);
  const reserveUsd = asNumber(item.market_info?.reserve_native_usd);
  if (reserveUsd > 0) return reserveUsd * 2;
  const quotePrice = tokenQuotePriceUsd(item);
  return reserveNative > 0 && quotePrice > 0 ? reserveNative * quotePrice * 2 : 0;
}
function tokenVolume5mUsd(item: NadFunToken, fallback: number, quotePriceUsd: number): number {
  const explicit = asNumber(item.market_info?.volume_5m_usd) || asNumber(item.market_info?.volume5m_usd);
  if (explicit > 0) return explicit;
  const explicitNative = asNumber(item.market_info?.volume_5m) || asNumber(item.market_info?.volume5m);
  if (explicitNative > 0 && quotePriceUsd > 0) return explicitNative * quotePriceUsd;
  return fallback;
}
function tokenHolders(item: NadFunToken): number { return asNumber(item.market_info?.holder_count) || asNumber(item.market_info?.holders) || asNumber(item.token_info?.holder_count); }

async function bootstrapFactoryTokens(env: IndexEnv, client: ReturnType<typeof publicClient>): Promise<number> {
  const existing = await env.DB.prepare("SELECT COUNT(*) as count FROM tokens").first<{ count: number }>();
  if (Number(existing?.count || 0) > 0) return 0;
  try {
    const pairCount = await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairsLength" });
    const total = Number(pairCount);
    if (!Number.isFinite(total) || total <= 0) return 0;
    const start = Math.max(0, total - FACTORY_BOOTSTRAP_PAIR_LIMIT);
    let inserted = 0;
    for (let i = start; i < total; i++) {
      const pair = await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] });
      const [token0, token1] = await Promise.all([
        client.readContract({ address: pair, abi: factoryPairAbi, functionName: "token0" }),
        client.readContract({ address: pair, abi: factoryPairAbi, functionName: "token1" })
      ]);
      const token0IsQuote = token0.toLowerCase() === WMON.toLowerCase() || token0.toLowerCase() === LVMON.toLowerCase();
      const token1IsQuote = token1.toLowerCase() === WMON.toLowerCase() || token1.toLowerCase() === LVMON.toLowerCase();
      if (!token0IsQuote && !token1IsQuote) continue;
      const quote = token0IsQuote ? token0 : token1;
      const token = token0IsQuote ? token1 : token0;
      const [totalSupply, decimals, symbol, name] = await Promise.all([
        client.readContract({ address: token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null),
        client.readContract({ address: token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18),
        client.readContract({ address: token, abi: tokenMetaAbi, functionName: "symbol" }).catch(() => null),
        client.readContract({ address: token, abi: tokenMetaAbi, functionName: "name" }).catch(() => null)
      ]);
      const now = Date.now();
      await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET pair_address=excluded.pair_address,quote_token=excluded.quote_token,graduated=1,last_seen_ms=excluded.last_seen_ms`).bind(
        token, symbol, name, 0, 0, now, now, totalSupply?.toString() ?? null, Number(decimals), quote, pair, 1
      ).run();
      inserted++;
    }
    return inserted;
  } catch (error) { console.error(`Factory bootstrap failed: ${String(error).slice(0, 500)}`); return 0; }
}

export async function indexNadFun(env: IndexEnv, maxBlocks = RPC_LOG_RANGE_BLOCKS): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const stateRaw = await env.CIEL_STATE.get(INDEXER_STATE_KEY);
  const state = stateRaw ? JSON.parse(stateRaw) as IndexerState : null;
  const cursorRaw = state?.nextBlock ?? await env.CIEL_STATE.get("indexer_next_block");
  let fromBlock = cursorRaw ? BigInt(cursorRaw) : (latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n);
  if (latest > fromBlock && latest - fromBlock > MAX_ACCEPTABLE_LAG_BLOCKS) fromBlock = latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n;
  if (fromBlock > latest) return null;
  const requestedBlocks = Math.max(1, Math.min(Math.floor(maxBlocks), RPC_LOG_RANGE_BLOCKS));
  const toBlock = fromBlock + BigInt(requestedBlocks - 1) > latest ? latest : fromBlock + BigInt(requestedBlocks - 1);

  const [creates, bondingBuys, bondingSells, routerBuys, routerSells, graduates, syncs, snipingPenalties, pairCreates, rankedMarkets] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: bondingBuyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: bondingSellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerBuyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerSellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: snipingEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_FACTORY, event: pairCreatedEvent, fromBlock, toBlock }),
    fetchNadFunMarketRanking()
  ]);

  const stats = new Map<string, { buyVolume: bigint; sellVolume: bigint; buys: number; sells: number; liquidityQuote: bigint }>();
  const touch = (token: string) => {
    let s = stats.get(token);
    if (!s) { s = { buyVolume: 0n, sellVolume: 0n, buys: 0, sells: 0, liquidityQuote: 0n }; stats.set(token, s); }
    return s;
  };

  for (const log of creates) {
    const a = log.args;
    if (!a.token || !a.quoteToken || !a.pair) continue;
    const [totalSupply, decimals] = await Promise.all([
      client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null),
      client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18)
    ]);
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=excluded.quote_token,pair_address=excluded.pair_address,created_at_block=COALESCE(tokens.created_at_block,excluded.created_at_block)`)
      .bind(a.token, a.symbol ?? null, a.name ?? null, 0, 0, Date.now(), Date.now(), totalSupply?.toString() ?? null, Number(decimals), a.quoteToken, a.pair, 0, Number(log.blockNumber)).run();
  }

  for (const log of pairCreates) {
    const a = log.args;
    if (!a.token0 || !a.token1 || !a.pair) continue;
    const token0IsQuote = a.token0.toLowerCase() === WMON.toLowerCase() || a.token0.toLowerCase() === LVMON.toLowerCase();
    const token1IsQuote = a.token1.toLowerCase() === WMON.toLowerCase() || a.token1.toLowerCase() === LVMON.toLowerCase();
    if (!token0IsQuote && !token1IsQuote) continue;
    const quote = token0IsQuote ? a.token0 : a.token1;
    const token = token0IsQuote ? a.token1 : a.token0;
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET pair_address=excluded.pair_address,quote_token=excluded.quote_token,graduated=1,last_seen_ms=excluded.last_seen_ms`).bind(
      token, null, null, 0, 0, Date.now(), Date.now(), null, 18, quote, a.pair, 1
    ).run();
  }

  for (const log of routerBuys) {
    const a = log.args; if (!a.token) continue; const s = touch(a.token); s.buyVolume += a.amountIn ?? 0n; s.buys++;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-router-buy.json`, JSON.stringify({ type: "Buy", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, buyer: a.buyer, amountIn: a.amountIn?.toString(), amountOut: a.amountOut?.toString(), graduated: a.graduated }));
  }
  for (const log of routerSells) {
    const a = log.args; if (!a.token) continue; const s = touch(a.token); s.sellVolume += a.amountOut ?? 0n; s.sells++;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-router-sell.json`, JSON.stringify({ type: "Sell", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, seller: a.seller, amountIn: a.amountIn?.toString(), amountOut: a.amountOut?.toString(), graduated: a.graduated }));
  }
  if (routerBuys.length === 0) for (const log of bondingBuys) { const a = log.args; if (!a.token) continue; const s = touch(a.token); s.buyVolume += a.quoteIn ?? 0n; s.buys++; }
  if (routerSells.length === 0) for (const log of bondingSells) { const a = log.args; if (!a.token) continue; const s = touch(a.token); s.sellVolume += a.quoteOut ?? 0n; s.sells++; }

  for (const log of syncs) {
    const a = log.args; if (!a.token) continue; touch(a.token).liquidityQuote = a.realQuoteReserve ?? 0n;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-sync.json`, JSON.stringify({ type: "Sync", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, realQuoteReserve: a.realQuoteReserve?.toString(), realTokenReserve: a.realTokenReserve?.toString(), virtualQuoteReserve: a.virtualQuoteReserve?.toString(), virtualTokenReserve: a.virtualTokenReserve?.toString() }));
  }
  for (const log of graduates) {
    const a = log.args; if (!a.token) continue; await env.DB.prepare("UPDATE tokens SET graduated=1,pair_address=? WHERE address=?").bind(a.pair ?? null, a.token).run();
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-graduate.json`, JSON.stringify({ type: "Graduate", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, pair: a.pair }));
  }
  for (const log of snipingPenalties) {
    const a = log.args; if (!a.token) continue;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-sniping.json`, JSON.stringify({ type: "SnipingPenalty", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, penaltyBps: a.penaltyBps?.toString() }));
  }

  await bootstrapFactoryTokens(env, client);

  const ranked = rankedMarkets.filter(item => !!tokenId(item));
  const topEstablished = ranked
    .map(item => ({ item, token: tokenId(item)! }))
    .filter(({ item }) => tokenMarketCap(item, 18) >= MIN_MARKET_CAP_USD)
    .slice(0, ESTABLISHED_TOKEN_LIMIT);

  for (const { item, token } of topEstablished) {
    const existing = await env.DB.prepare("SELECT decimals,total_supply,quote_token,pair_address,graduated,liquidity_usd,market_cap_usd,symbol,name FROM tokens WHERE address=?").bind(token).first<{ decimals: number; total_supply: string | null; quote_token: string | null; pair_address: string | null; graduated: number; liquidity_usd: number | null; market_cap_usd: number | null; symbol: string | null; name: string | null }>();
    const decimals = Number(existing?.decimals || asNumber(item.token_info?.decimals) || 18);
    const apiSupply = item.market_info?.total_supply ?? item.token_info?.total_supply;
    const totalSupplyRaw = asString(apiSupply) ?? existing?.total_supply ?? null;
    const marketCapUsd = tokenMarketCap(item, decimals);
    const priceUsd = tokenPriceUsd(item);
    const quotePriceUsd = tokenQuotePriceUsd(item);
    const eventStats = stats.get(token) ?? { buyVolume: 0n, sellVolume: 0n, buys: 0, sells: 0, liquidityQuote: 0n };
    const eventVolumeNative = Number(eventStats.buyVolume + eventStats.sellVolume) / 1e18;
    const eventVolumeUsd = quotePriceUsd > 0 ? eventVolumeNative * quotePriceUsd : 0;
    const liquidityUsd = tokenLiquidityUsd(item) || Number(existing?.liquidity_usd || 0);
    const volume5mUsd = tokenVolume5mUsd(item, eventVolumeUsd, quotePriceUsd);
    const quoteToken = tokenQuote(item) || existing?.quote_token;
    const pairAddress = tokenPair(item) || existing?.pair_address;
    const graduated = tokenGraduated(item) || Number(existing?.graduated || 0);
    const holders = tokenHolders(item);
    if (!(marketCapUsd >= MIN_MARKET_CAP_USD) || !(priceUsd > 0)) continue;

    const now = Date.now();
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(excluded.symbol,tokens.symbol),name=COALESCE(excluded.name,tokens.name),market_cap_usd=excluded.market_cap_usd,liquidity_usd=excluded.liquidity_usd,last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=COALESCE(excluded.quote_token,tokens.quote_token),pair_address=COALESCE(excluded.pair_address,tokens.pair_address),graduated=excluded.graduated`)
      .bind(token, tokenSymbol(item), tokenName(item), marketCapUsd, liquidityUsd, existing ? Number(existing.last_seen_ms || now) : now, now, totalSupplyRaw, decimals, quoteToken, pairAddress, graduated).run();

    await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      token, now, priceUsd, marketCapUsd, liquidityUsd, volume5mUsd, eventStats.buys, eventStats.sells, holders, quoteToken, quotePriceUsd > 0 ? Number(eventStats.buyVolume) / 1e18 * quotePriceUsd : 0, quotePriceUsd > 0 ? Number(eventStats.sellVolume) / 1e18 * quotePriceUsd : 0, Number(toBlock)
    ).run();
  }

  // Preserve event-driven discovery data even when those tokens are below the trading floor.
  // They never enter the model snapshot universe unless NadFun ranks them at >= $90k.
  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({ nextBlock: (toBlock + 1n).toString(), latestBlock: latest.toString(), lastSnapshotCount: topEstablished.length, lastRunMs: Date.now() } satisfies IndexerState));
  return { fromBlock, toBlock, creates: creates.length, buys: routerBuys.length || bondingBuys.length, sells: routerSells.length || bondingSells.length, graduates: graduates.length, syncs: syncs.length, snapshots: topEstablished.length, nextBlock: toBlock + 1n };
}
