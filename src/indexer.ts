import { parseAbiItem } from "viem";
import { NADFUN_BONDING, publicClient } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const buyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const sellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");
const tokenMetaAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

export interface IndexResult { fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; nextBlock: bigint; }

async function monUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd");
    const j = await r.json() as { monad?: { usd?: number } };
    return Number(j.monad?.usd || 0);
  } catch { return 0; }
}

export async function indexNadFun(env: { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA: R2Bucket; NAD_RPC_URL?: string }, maxBlocks = 3000): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const cursorRaw = await env.CIEL_STATE.get("indexer_next_block");
  const fromBlock = cursorRaw ? BigInt(cursorRaw) : latest > 216_000n ? latest - 216_000n : 73_857_231n;
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

  for (const log of creates) {
    const a = log.args;
    if (!a.token) continue;
    let totalSupply: bigint | null = null; let decimals = 18;
    try {
      totalSupply = await client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "totalSupply" });
      decimals = await client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "decimals" });
    } catch {}
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=COALESCE(excluded.decimals,tokens.decimals)`).bind(a.token, a.symbol ?? null, a.name ?? null, 0, 0, Date.now(), Date.now(), totalSupply?.toString() ?? null, decimals).run();
  }

  const tokenStats = new Map<string, { quote: bigint; token: bigint; buys: number; sells: number; liquidityQuote: bigint }>();
  const touch = (token: string) => { let x = tokenStats.get(token); if (!x) { x = { quote: 0n, token: 0n, buys: 0, sells: 0, liquidityQuote: 0n }; tokenStats.set(token, x); } return x; };
  for (const log of buys) {
    const a = log.args; if (!a.token) continue; const x = touch(a.token); x.quote += a.quoteIn ?? 0n; x.token += a.tokenOut ?? 0n; x.buys++;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-buy.json`, JSON.stringify({ type: "Buy", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, quoteIn: a.quoteIn?.toString(), tokenOut: a.tokenOut?.toString() }));
  }
  for (const log of sells) {
    const a = log.args; if (!a.token) continue; const x = touch(a.token); x.quote += a.quoteOut ?? 0n; x.token += a.tokenIn ?? 0n; x.sells++;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sell.json`, JSON.stringify({ type: "Sell", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, tokenIn: a.tokenIn?.toString(), quoteOut: a.quoteOut?.toString() }));
  }
  for (const log of syncs) {
    const a = log.args; if (!a.token) continue; touch(a.token).liquidityQuote = a.realQuoteReserve ?? 0n;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sync.json`, JSON.stringify({ type: "Sync", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, realQuoteReserve: a.realQuoteReserve?.toString(), realTokenReserve: a.realTokenReserve?.toString(), virtualQuoteReserve: a.virtualQuoteReserve?.toString(), virtualTokenReserve: a.virtualTokenReserve?.toString() }));
  }
  for (const log of graduates) {
    const a = log.args; if (!a.token) continue;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-graduate.json`, JSON.stringify({ type: "Graduate", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, pair: a.pair }));
  }

  const ts = Date.now();
  for (const [token, s] of tokenStats) {
    if (s.token === 0n) continue;
    const priceMon = Number(s.quote) / Number(s.token);
    const priceUsd = priceMon * monPrice;
    const volumeUsd = Number(s.quote) / 1e18 * monPrice;
    const liquidityUsd = Number(s.liquidityQuote) / 1e18 * monPrice;
    const meta = await env.DB.prepare("SELECT total_supply, decimals FROM tokens WHERE address=?").bind(token).first<{ total_supply: string | null; decimals: number | null }>();
    const supply = meta?.total_supply ? Number(meta.total_supply) / 10 ** Number(meta.decimals ?? 18) : 0;
    const marketCapUsd = priceUsd * supply;
    await env.DB.prepare("INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders) VALUES(?,?,?,?,?,?,?,?,?)").bind(token, ts, priceUsd, marketCapUsd, liquidityUsd, volumeUsd, s.buys, s.sells, 0).run();
    await env.DB.prepare("UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=? WHERE address=?").bind(marketCapUsd, liquidityUsd, ts, token).run();
  }

  await env.CIEL_STATE.put("indexer_next_block", (toBlock + 1n).toString());
  await env.CIEL_STATE.put("indexer_latest_block", latest.toString());
  await env.CIEL_STATE.put("mon_usd", String(monPrice));
  return { fromBlock, toBlock, creates: creates.length, buys: buys.length, sells: sells.length, graduates: graduates.length, syncs: syncs.length, nextBlock: toBlock + 1n };
}
