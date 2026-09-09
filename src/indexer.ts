import { parseAbiItem, type Address } from "viem";
import { NADFUN_BONDING, NADFUN_FACTORY, NADFUN_ROUTER, publicClient, quoteSell, WMON, LVMON } from "./nadfun";

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

const pairAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" }] }
] as const;

const factoryAbi = [
  { type: "function", name: "allPairsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allPairs", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] }
] as const;

export interface IndexResult { fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; snapshots: number; nextBlock: bigint; }
type IndexEnv = { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA?: R2Bucket; NAD_RPC_URL?: string };

const INDEXER_STATE_KEY = "indexer_state";
const RPC_LOG_RANGE_BLOCKS = 100;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const EXISTING_TOKEN_SNAPSHOT_LIMIT = 50;
const FACTORY_BOOTSTRAP_PAIR_LIMIT = 20;
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };

async function monUsd(env: IndexEnv): Promise<number> {
  const cached = Number(await env.CIEL_STATE.get("mon_usd"));
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd", { cf: { cacheTtl: 60 } });
    if (!r.ok) return cached > 0 ? cached : 0;
    const j = await r.json() as { monad?: { usd?: number } };
    const price = Number(j.monad?.usd || 0);
    if (price > 0) await env.CIEL_STATE.put("mon_usd", String(price), { expirationTtl: 3600 });
    return price > 0 ? price : cached > 0 ? price : 0;
  } catch { return cached > 0 ? cached : 0; }
}

function rawToUnits(value: bigint, decimals: number): number { return Number(value) / 10 ** decimals; }

async function pairLiquidityUsd(client: ReturnType<typeof publicClient>, pair: Address, token: Address, quoteToken: Address, monUsdPrice: number): Promise<number> {
  if (monUsdPrice <= 0 || (quoteToken.toLowerCase() !== WMON.toLowerCase() && quoteToken.toLowerCase() !== LVMON.toLowerCase())) return 0;
  try {
    const [token0, reserves] = await Promise.all([
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" })
    ]);
    const quoteReserve = token0.toLowerCase() === token.toLowerCase() ? reserves[1] : reserves[0];
    return rawToUnits(quoteReserve, 18) * monUsdPrice * 2;
  } catch { return 0; }
}

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
        client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "token1" })
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
  } catch (error) {
    console.error(`Factory bootstrap failed: ${String(error).slice(0, 500)}`);
    return 0;
  }
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

  const [creates, bondingBuys, bondingSells, routerBuys, routerSells, graduates, syncs, snipingPenalties, pairCreates, monPrice] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: bondingBuyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: bondingSellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerBuyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerSellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: snipingEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_FACTORY, event: pairCreatedEvent, fromBlock, toBlock }),
    monUsd(env)
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
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=excluded.quote_token,pair_address=excluded.pair_address,created_at_block=COALESCE(tokens.created_at_block,excluded.created_at_block)`)
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
    const [totalSupply, decimals, symbol, name] = await Promise.all([
      client.readContract({ address: token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null),
      client.readContract({ address: token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18),
      client.readContract({ address: token, abi: tokenMetaAbi, functionName: "symbol" }).catch(() => null),
      client.readContract({ address: token, abi: tokenMetaAbi, functionName: "name" }).catch(() => null)
    ]);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET pair_address=excluded.pair_address,quote_token=excluded.quote_token,graduated=1,last_seen_ms=excluded.last_seen_ms`).bind(
      token, symbol, name, 0, 0, now, now, totalSupply?.toString() ?? null, Number(decimals), quote, a.pair, 1
    ).run();
  }

  for (const log of routerBuys) {
    const a = log.args; if (!a.token) continue;
    const s = touch(a.token); s.buyVolume += a.amountIn ?? 0n; s.buys++;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-router-buy.json`, JSON.stringify({ type: "Buy", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, buyer: a.buyer, amountIn: a.amountIn?.toString(), amountOut: a.amountOut?.toString(), graduated: a.graduated }));
  }
  for (const log of routerSells) {
    const a = log.args; if (!a.token) continue;
    const s = touch(a.token); s.sellVolume += a.amountOut ?? 0n; s.sells++;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-router-sell.json`, JSON.stringify({ type: "Sell", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, seller: a.seller, amountIn: a.amountIn?.toString(), amountOut: a.amountOut?.toString(), graduated: a.graduated }));
  }
  if (routerBuys.length === 0) for (const log of bondingBuys) { const a = log.args; if (!a.token) continue; const s = touch(a.token); s.buyVolume += a.quoteIn ?? 0n; s.buys++; }
  if (routerSells.length === 0) for (const log of bondingSells) { const a = log.args; if (!a.token) continue; const s = touch(a.token); s.sellVolume += a.quoteOut ?? 0n; s.sells++; }

  for (const log of syncs) {
    const a = log.args; if (!a.token) continue;
    touch(a.token).liquidityQuote = a.realQuoteReserve ?? 0n;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-sync.json`, JSON.stringify({ type: "Sync", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, realQuoteReserve: a.realQuoteReserve?.toString(), realTokenReserve: a.realTokenReserve?.toString(), virtualQuoteReserve: a.virtualQuoteReserve?.toString(), virtualTokenReserve: a.virtualTokenReserve?.toString() }));
  }
  for (const log of graduates) {
    const a = log.args; if (!a.token) continue;
    await env.DB.prepare("UPDATE tokens SET graduated=1,pair_address=? WHERE address=?").bind(a.pair ?? null, a.token).run();
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-graduate.json`, JSON.stringify({ type: "Graduate", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, pair: a.pair }));
  }
  for (const log of snipingPenalties) {
    const a = log.args; if (!a.token) continue;
    await env.MARKET_DATA?.put(`events/${log.blockNumber}-${log.logIndex}-sniping.json`, JSON.stringify({ type: "SnipingPenalty", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, penaltyBps: a.penaltyBps?.toString() }));
  }

  await bootstrapFactoryTokens(env, client);

  const existingTokens = await env.DB.prepare(`SELECT address,total_supply,decimals,quote_token,pair_address,graduated,liquidity_usd,symbol,name FROM tokens WHERE quote_token IS NOT NULL ORDER BY last_seen_ms DESC LIMIT ?`).bind(EXISTING_TOKEN_SNAPSHOT_LIMIT).all<{
    address: string; total_supply: string | null; decimals: number; quote_token: string | null; pair_address: string | null; graduated: number; liquidity_usd: number | null; symbol: string | null; name: string | null;
  }>();
  for (const row of existingTokens.results ?? []) touch(row.address);

  const ts = Date.now();
  let snapshots = 0;
  for (const [token, s] of stats) {
    const meta = await env.DB.prepare("SELECT total_supply, decimals, quote_token, pair_address, graduated, liquidity_usd FROM tokens WHERE address=?").bind(token).first<{
      total_supply: string | null; decimals: number; quote_token: string | null; pair_address: string | null; graduated: number; liquidity_usd: number | null;
    }>();
    if (!meta || !meta.quote_token) continue;
    const decimals = Number(meta.decimals || 18);
    const quoteOut = await quoteSell(client, token as Address, 10n ** BigInt(decimals)).catch(() => 0n);
    const quoteUsd = meta.quote_token.toLowerCase() === WMON.toLowerCase() || meta.quote_token.toLowerCase() === LVMON.toLowerCase() ? monPrice : 0;
    const priceUsd = quoteUsd > 0 ? rawToUnits(quoteOut, 18) * quoteUsd : 0;
    const supply = meta.total_supply ? rawToUnits(BigInt(meta.total_supply), decimals) : 0;
    const marketCapUsd = priceUsd * supply;
    let liquidityUsd = quoteUsd > 0 ? rawToUnits(s.liquidityQuote, 18) * quoteUsd * 2 : 0;
    if (liquidityUsd <= 0 && meta.liquidity_usd) liquidityUsd = Number(meta.liquidity_usd);
    if (Number(meta.graduated) === 1 && meta.pair_address) {
      const pairLiquidity = await pairLiquidityUsd(client, meta.pair_address as Address, token as Address, meta.quote_token as Address, monPrice);
      if (pairLiquidity > 0) liquidityUsd = pairLiquidity;
    }
    const buyVolumeUsd = quoteUsd > 0 ? rawToUnits(s.buyVolume, 18) * quoteUsd : 0;
    const sellVolumeUsd = quoteUsd > 0 ? rawToUnits(s.sellVolume, 18) * quoteUsd : 0;
    await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(token, ts, priceUsd, marketCapUsd, liquidityUsd, buyVolumeUsd + sellVolumeUsd, s.buys, s.sells, 0, meta.quote_token, buyVolumeUsd, sellVolumeUsd, Number(toBlock)).run();
    await env.DB.prepare("UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=? WHERE address=?").bind(marketCapUsd, liquidityUsd, ts, token).run();
    snapshots++;
  }

  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({ nextBlock: (toBlock + 1n).toString(), latestBlock: latest.toString(), lastSnapshotCount: snapshots, lastRunMs: ts } satisfies IndexerState));
  return { fromBlock, toBlock, creates: creates.length, buys: routerBuys.length || bondingBuys.length, sells: routerSells.length || bondingSells.length, graduates: graduates.length, syncs: syncs.length, snapshots, nextBlock: toBlock + 1n };
}
