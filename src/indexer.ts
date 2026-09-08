import { parseAbiItem, type Address } from "viem";
import { NADFUN_BONDING, publicClient, quoteSell } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const buyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const sellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");

const tokenMetaAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

const pairAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" }] }
] as const;

export interface IndexResult { fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; snapshots: number; nextBlock: bigint; }

async function monUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd", { cf: { cacheTtl: 60 } });
    if (!r.ok) return 0;
    const j = await r.json() as { monad?: { usd?: number } };
    return Number(j.monad?.usd || 0);
  } catch { return 0; }
}

function rawToUnits(value: bigint, decimals: number): number { return Number(value) / 10 ** decimals; }

async function pairLiquidityUsd(client: ReturnType<typeof publicClient>, pair: Address, token: Address, monUsdPrice: number): Promise<number> {
  try {
    const [token0, reserves] = await Promise.all([
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" })
    ]);
    const quoteReserve = token0.toLowerCase() === token.toLowerCase() ? reserves[1] : reserves[0];
    return rawToUnits(quoteReserve, 18) * monUsdPrice * 2;
  } catch { return 0; }
}

export async function indexNadFun(env: { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA: R2Bucket; NAD_RPC_URL?: string }, maxBlocks = 3000): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const cursorRaw = await env.CIEL_STATE.get("indexer_next_block");
  const fromBlock = cursorRaw ? BigInt(cursorRaw) : 73_857_231n;
  if (fromBlock > latest) return null;
  const toBlock = fromBlock + BigInt(maxBlocks - 1) > latest ? latest : fromBlock + BigInt(maxBlocks - 1);
  const [creates, buys, sells, graduates, syncs, monPrice] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: buyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: sellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock }),
    monUsd()
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
    const totalSupply = await client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null);
    const decimals = await client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18);
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=excluded.quote_token,pair_address=excluded.pair_address,created_at_block=COALESCE(tokens.created_at_block,excluded.created_at_block)`)
      .bind(a.token, a.symbol ?? null, a.name ?? null, 0, 0, Date.now(), Date.now(), totalSupply?.toString() ?? null, Number(decimals), a.quoteToken, a.pair, 0, Number(log.blockNumber)).run();
  }

  for (const log of buys) {
    const a = log.args;
    if (!a.token) continue;
    const s = touch(a.token); s.buyVolume += a.quoteIn ?? 0n; s.buys++;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-buy.json`, JSON.stringify({ type: "Buy", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, buyer: a.buyer, quoteIn: a.quoteIn?.toString(), tokenOut: a.tokenOut?.toString() }));
  }

  for (const log of sells) {
    const a = log.args;
    if (!a.token) continue;
    const s = touch(a.token); s.sellVolume += a.quoteOut ?? 0n; s.sells++;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sell.json`, JSON.stringify({ type: "Sell", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, seller: a.seller, tokenIn: a.tokenIn?.toString(), quoteOut: a.quoteOut?.toString() }));
  }

  for (const log of syncs) {
    const a = log.args;
    if (!a.token) continue;
    touch(a.token).liquidityQuote = a.realQuoteReserve ?? 0n;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sync.json`, JSON.stringify({ type: "Sync", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, realQuoteReserve: a.realQuoteReserve?.toString(), realTokenReserve: a.realTokenReserve?.toString(), virtualQuoteReserve: a.virtualQuoteReserve?.toString(), virtualTokenReserve: a.virtualTokenReserve?.toString() }));
  }

  for (const log of graduates) {
    const a = log.args;
    if (!a.token) continue;
    await env.DB.prepare("UPDATE tokens SET graduated=1,pair_address=? WHERE address=?").bind(a.pair ?? null, a.token).run();
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-graduate.json`, JSON.stringify({ type: "Graduate", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, pair: a.pair }));
  }

  let snapshots = 0;
  const ts = Date.now();
  for (const [token, s] of stats) {
    const meta = await env.DB.prepare("SELECT total_supply, decimals, quote_token, pair_address, graduated FROM tokens WHERE address=?").bind(token).first<{ total_supply: string | null; decimals: number; quote_token: string | null; pair_address: string | null; graduated: number }>();
    if (!meta) continue;
    const decimals = Number(meta.decimals || 18);
    const quoteOut = await quoteSell(client, token as Address, 10n ** BigInt(decimals)).catch(() => 0n);
    const priceUsd = monPrice > 0 ? rawToUnits(quoteOut, 18) * monPrice : 0;
    const supply = meta.total_supply ? rawToUnits(BigInt(meta.total_supply), decimals) : 0;
    const marketCapUsd = priceUsd * supply;
    let liquidityUsd = rawToUnits(s.liquidityQuote, 18) * monPrice * 2;
    if (Number(meta.graduated) === 1 && meta.pair_address) liquidityUsd = await pairLiquidityUsd(client, meta.pair_address as Address, token as Address, monPrice);
    const buyVolumeUsd = rawToUnits(s.buyVolume, 18) * monPrice;
    const sellVolumeUsd = rawToUnits(s.sellVolume, 18) * monPrice;
    await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(token, ts, priceUsd, marketCapUsd, liquidityUsd, buyVolumeUsd + sellVolumeUsd, s.buys, s.sells, 0, meta.quote_token, buyVolumeUsd, sellVolumeUsd, Number(toBlock)).run();
    await env.DB.prepare("UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=? WHERE address=?").bind(marketCapUsd, liquidityUsd, ts, token).run();
    snapshots++;
  }

  await env.CIEL_STATE.put("indexer_next_block", (toBlock + 1n).toString());
  await env.CIEL_STATE.put("indexer_latest_block", latest.toString());
  await env.CIEL_STATE.put("mon_usd", String(monPrice));
  await env.CIEL_STATE.put("indexer_last_snapshot_count", String(snapshots));
  return { fromBlock, toBlock, creates: creates.length, buys: buys.length, sells: sells.length, graduates: graduates.length, syncs: syncs.length, snapshots, nextBlock: toBlock + 1n };
}
