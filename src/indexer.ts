import { parseAbiItem, type PublicClient } from "viem";
import { NADFUN_BONDING, publicClient } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const buyEvent = parseAbiItem("event Buy(address indexed token,address indexed buyer,uint256 quoteIn,uint256 tokenOut)");
const sellEvent = parseAbiItem("event Sell(address indexed token,address indexed seller,uint256 tokenIn,uint256 quoteOut)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");

export interface IndexResult { fromBlock: bigint; toBlock: bigint; creates: number; buys: number; sells: number; graduates: number; syncs: number; nextBlock: bigint; }

export async function indexNadFun(env: { CIEL_STATE: KVNamespace; DB: D1Database; MARKET_DATA: R2Bucket; NAD_RPC_URL?: string }, maxBlocks = 3000): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL);
  const latest = await client.getBlockNumber();
  const cursorRaw = await env.CIEL_STATE.get("indexer_next_block");
  const fromBlock = cursorRaw ? BigInt(cursorRaw) : latest > 86_400n ? latest - 86_400n : 73_857_231n;
  if (fromBlock > latest) return null;
  const toBlock = fromBlock + BigInt(maxBlocks - 1) > latest ? latest : fromBlock + BigInt(maxBlocks - 1);

  const [creates, buys, sells, graduates, syncs] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: buyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: sellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock })
  ]);

  for (const log of creates) {
    const a = log.args;
    if (!a.token) continue;
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,last_seen_ms=excluded.last_seen_ms`).bind(a.token, a.symbol ?? null, a.name ?? null, 0, 0, Date.now(), Date.now()).run();
  }
  for (const log of buys) {
    const a = log.args;
    if (!a.token) continue;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-buy.json`, JSON.stringify({ type: "Buy", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, quoteIn: a.quoteIn?.toString(), tokenOut: a.tokenOut?.toString() }));
  }
  for (const log of sells) {
    const a = log.args;
    if (!a.token) continue;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sell.json`, JSON.stringify({ type: "Sell", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, tokenIn: a.tokenIn?.toString(), quoteOut: a.quoteOut?.toString() }));
  }
  for (const log of graduates) {
    const a = log.args;
    if (!a.token) continue;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-graduate.json`, JSON.stringify({ type: "Graduate", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, pair: a.pair }));
  }
  for (const log of syncs) {
    const a = log.args;
    if (!a.token) continue;
    await env.MARKET_DATA.put(`events/${log.blockNumber}-${log.logIndex}-sync.json`, JSON.stringify({ type: "Sync", block: log.blockNumber.toString(), tx: log.transactionHash, token: a.token, realQuoteReserve: a.realQuoteReserve?.toString(), realTokenReserve: a.realTokenReserve?.toString(), virtualQuoteReserve: a.virtualQuoteReserve?.toString(), virtualTokenReserve: a.virtualTokenReserve?.toString() }));
  }
  await env.CIEL_STATE.put("indexer_next_block", (toBlock + 1n).toString());
  await env.CIEL_STATE.put("indexer_latest_block", latest.toString());
  return { fromBlock, toBlock, creates: creates.length, buys: buys.length, sells: sells.length, graduates: graduates.length, syncs: syncs.length, nextBlock: toBlock + 1n };
}
