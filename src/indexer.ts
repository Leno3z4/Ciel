import { parseAbiItem } from "viem";
import { NADFUN_BONDING, NADFUN_FACTORY, NADFUN_ROUTER, publicClient, WMON, LVMON } from "./nadfun";

const createEvent = parseAbiItem("event Create(address indexed creator,address indexed token,address indexed pair,address quoteToken,string name,string symbol,string tokenURI,uint256 virtualQuoteReserve,uint256 virtualTokenReserve,uint256 minTokenReserve)");
const routerBuyEvent = parseAbiItem("event Buy(address indexed buyer,address indexed token,uint256 amountIn,uint256 amountOut,bool graduated)");
const routerSellEvent = parseAbiItem("event Sell(address indexed seller,address indexed token,uint256 amountIn,uint256 amountOut,bool graduated)");
const graduateEvent = parseAbiItem("event Graduate(address indexed token,address indexed pair)");
const syncEvent = parseAbiItem("event Sync(address indexed token,uint256 realQuoteReserve,uint256 realTokenReserve,uint256 virtualQuoteReserve,uint256 virtualTokenReserve)");
const pairCreatedEvent = parseAbiItem("event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)");
const tokenMetaAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
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
type NadFunToken = { token_info?: Record<string, unknown>; market_info?: Record<string, unknown>; percent?: number | string };
type ChartRow = { t: number; c: number; v: number };
type IndexerState = { nextBlock: string; latestBlock: string; lastSnapshotCount: number; lastRunMs?: number };

const INDEXER_STATE_KEY = "indexer_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const RANKING_FETCH_TS_KEY = "nadfun_market_ranking_fetch_ms";
const RPC_LOG_RANGE_BLOCKS = 100;
const MAX_ACCEPTABLE_LAG_BLOCKS = 10_000n;
const LIVE_BOOTSTRAP_BLOCKS = 5_000n;
const MARKET_LIMIT = 50;
const SNAPSHOT_LIMIT = 12;
const MIN_MARKET_CAP_USD = 90_000;
const API_BASE = "https://api.nadapp.net";
const RANKING_REFRESH_MS = 10 * 60 * 1000;

function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function str(v: unknown): string | null { return typeof v === "string" && v.length ? v : null; }
function isAddress(v: string | null): v is `0x${string}` { return !!v && /^0x[a-fA-F0-9]{40}$/.test(v); }
function units(v: unknown, decimals: number): number { const n = num(v); if (!(n > 0)) return 0; return n >= 1e15 ? n / 10 ** decimals : n; }
function decode(text: string): unknown | null { try { return JSON.parse(text); } catch {} try { const b = atob(text.trim()); return JSON.parse(new TextDecoder().decode(Uint8Array.from(b, c => c.charCodeAt(0)))); } catch { return null; } }
function tokenAddress(item: NadFunToken): string | null { const a = str(item.token_info?.token_id); if (isAddress(a)) return a; const b = str(item.token_info?.address); return isAddress(b) ? b : null; }
function marketCap(item: NadFunToken, decimals: number): number { const direct = num(item.market_info?.market_cap_usd) || num(item.market_info?.market_cap) || num(item.token_info?.market_cap_usd) || num(item.token_info?.market_cap); if (direct > 0) return direct; const p = num(item.market_info?.price_usd) || num(item.market_info?.price); const supply = units(item.market_info?.total_supply ?? item.token_info?.total_supply, decimals); return p > 0 && supply > 0 ? p * supply : 0; }
function price(item: NadFunToken): number { return num(item.market_info?.price_usd) || num(item.market_info?.price); }
function liquidity(item: NadFunToken): number { const x = num(item.market_info?.liquidity_usd) || num(item.market_info?.liquidity); if (x > 0) return x; const r = num(item.market_info?.reserve_native_usd); return r > 0 ? r * 2 : 0; }
function volume5m(item: NadFunToken): number { return num(item.market_info?.volume_5m_usd) || num(item.market_info?.volume5m_usd); }
function holders(item: NadFunToken): number { return num(item.market_info?.holder_count) || num(item.market_info?.holders) || num(item.token_info?.holder_count); }
function quote(item: NadFunToken): string | null { return str(item.market_info?.quote_id) || str(item.market_info?.quote_token) || str(item.token_info?.quote_token); }
function pair(item: NadFunToken): string | null { return str(item.market_info?.pair_address) || str(item.token_info?.pair_address) || str(item.market_info?.market_id); }
function graduated(item: NadFunToken): number { const t = str(item.market_info?.market_type); return t?.toUpperCase().includes("DEX") || item.token_info?.is_graduated === true ? 1 : 0; }

async function fetchRanking(env: IndexEnv): Promise<NadFunToken[]> {
  const cached = await env.CIEL_STATE.get(RANKING_CACHE_KEY);
  const lastFetch = num(await env.CIEL_STATE.get(RANKING_FETCH_TS_KEY));
  if (cached && Date.now() - lastFetch < RANKING_REFRESH_MS) { try { const x = JSON.parse(cached) as unknown; if (Array.isArray(x)) return x as NadFunToken[]; } catch {} }
  try {
    const response = await fetch(`${API_BASE}/order/market_cap?page=1&limit=${MARKET_LIMIT}&is_nsfw=false`, { headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" }, cf: { cacheTtl: 600 } });
    if (response.ok) {
      const decoded = decode(await response.text()) as { tokens?: NadFunToken[] } | null;
      if (decoded && Array.isArray(decoded.tokens)) { await env.CIEL_STATE.put(RANKING_CACHE_KEY, JSON.stringify(decoded.tokens), { expirationTtl: 3600 }); await env.CIEL_STATE.put(RANKING_FETCH_TS_KEY, String(Date.now()), { expirationTtl: 3600 }); return decoded.tokens; }
    } else console.error(`NadFun market ranking HTTP ${response.status}`);
  } catch (e) { console.error(`NadFun ranking failed: ${String(e).slice(0, 300)}`); }
  if (cached) { try { const x = JSON.parse(cached) as unknown; if (Array.isArray(x)) return x as NadFunToken[]; } catch {} }
  return [];
}

async function fetchChart(token: string): Promise<ChartRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 24 * 3600;
  const url = `${API_BASE}/trade/chart/${token}?resolution=60&from=${from}&to=${now}&countback=168&chart_type=market_cap_usd`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" }, cf: { cacheTtl: 300 } });
    if (!r.ok) return [];
    const d = await r.json() as { s?: string; t?: unknown[]; c?: unknown[]; v?: unknown[] };
    if (d.s !== "ok" || !Array.isArray(d.t) || !Array.isArray(d.c)) return [];
    const out: ChartRow[] = [];
    for (let i = 0; i < d.t.length; i++) { const c = num(d.c[i]); if (c > 0) out.push({ t: num(d.t[i]), c, v: num(d.v?.[i]) }); }
    return out;
  } catch { return []; }
}

async function seed(env: IndexEnv, token: string, item: NadFunToken | undefined): Promise<void> {
  const exists = await env.DB.prepare("SELECT address FROM tokens WHERE address=?").bind(token).first<{ address: string }>();
  if (exists) return;
  const decimals = Math.max(0, Math.floor(num(item?.market_info?.decimals ?? item?.token_info?.decimals) || 18));
  await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).bind(token, str(item?.token_info?.symbol), str(item?.token_info?.name), 0, 0, Date.now(), Date.now(), item?.market_info?.total_supply ?? item?.token_info?.total_supply ?? null, decimals, quote(item || {}), pair(item || {}), graduated(item || {})).run();
}

async function bootstrapFactory(env: IndexEnv, client: ReturnType<typeof publicClient>): Promise<void> {
  const count = num((await env.DB.prepare("SELECT COUNT(*) as count FROM tokens").first<{ count: number }>())?.count); if (count > 0) return;
  try {
    const total = Number(await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairsLength" }));
    for (let i = Math.max(0, total - 8); i < total; i++) {
      const p = await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] });
      const [a, b] = await Promise.all([client.readContract({ address: p, abi: factoryPairAbi, functionName: "token0" }), client.readContract({ address: p, abi: factoryPairAbi, functionName: "token1" })]);
      const aq = a.toLowerCase() === WMON.toLowerCase() || a.toLowerCase() === LVMON.toLowerCase(); const bq = b.toLowerCase() === WMON.toLowerCase() || b.toLowerCase() === LVMON.toLowerCase(); if (!aq && !bq) continue;
      await seed(env, aq ? b : a, undefined);
      await env.DB.prepare("UPDATE tokens SET quote_token=?,pair_address=?,graduated=1 WHERE address=?").bind(aq ? a : b, p, aq ? b : a).run();
    }
  } catch (e) { console.error(`Factory bootstrap failed: ${String(e).slice(0, 300)}`); }
}

export async function indexNadFun(env: IndexEnv, maxBlocks = RPC_LOG_RANGE_BLOCKS): Promise<IndexResult | null> {
  const client = publicClient(env.NAD_RPC_URL); const latest = await client.getBlockNumber();
  const stateRaw = await env.CIEL_STATE.get(INDEXER_STATE_KEY); const state = stateRaw ? JSON.parse(stateRaw) as IndexerState : null;
  const cursor = state?.nextBlock ?? await env.CIEL_STATE.get("indexer_next_block");
  let fromBlock = cursor ? BigInt(cursor) : (latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n);
  if (latest - fromBlock > MAX_ACCEPTABLE_LAG_BLOCKS) fromBlock = latest > LIVE_BOOTSTRAP_BLOCKS ? latest - LIVE_BOOTSTRAP_BLOCKS : 0n;
  if (fromBlock > latest) return null;
  const n = Math.max(1, Math.min(Math.floor(maxBlocks), RPC_LOG_RANGE_BLOCKS)); const toBlock = fromBlock + BigInt(n - 1) > latest ? latest : fromBlock + BigInt(n - 1);
  const [creates, buys, sells, graduates, syncs, pairs, ranked] = await Promise.all([
    client.getLogs({ address: NADFUN_BONDING, event: createEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerBuyEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_ROUTER, event: routerSellEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: graduateEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_BONDING, event: syncEvent, fromBlock, toBlock }),
    client.getLogs({ address: NADFUN_FACTORY, event: pairCreatedEvent, fromBlock, toBlock }),
    fetchRanking(env)
  ]);
  for (const x of creates) { const a = x.args; if (!a.token || !a.quoteToken || !a.pair) continue; const [s, d] = await Promise.all([client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "totalSupply" }).catch(() => null), client.readContract({ address: a.token, abi: tokenMetaAbi, functionName: "decimals" }).catch(() => 18)]); await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=excluded.quote_token,pair_address=excluded.pair_address`).bind(a.token, a.symbol ?? null, a.name ?? null, 0, 0, Date.now(), Date.now(), s?.toString() ?? null, Number(d), a.quoteToken, a.pair, 0, Number(x.blockNumber)).run(); }
  for (const x of pairs) { const a = x.args; if (!a.token0 || !a.token1 || !a.pair) continue; const aq = a.token0.toLowerCase() === WMON.toLowerCase() || a.token0.toLowerCase() === LVMON.toLowerCase(); const bq = a.token1.toLowerCase() === WMON.toLowerCase() || a.token1.toLowerCase() === LVMON.toLowerCase(); if (aq || bq) await seed(env, aq ? a.token1 : a.token0, undefined); }
  for (const x of graduates) { if (x.args.token) await env.DB.prepare("UPDATE tokens SET graduated=1,pair_address=? WHERE address=?").bind(x.args.pair ?? null, x.args.token).run(); }
  await bootstrapFactory(env, client);

  const rankedByToken = new Map<string, NadFunToken>(); for (const item of ranked) { const t = tokenAddress(item); if (t) rankedByToken.set(t.toLowerCase(), item); }
  for (const item of ranked) { const t = tokenAddress(item); if (t) await seed(env, t, item); }
  const existing = await env.DB.prepare("SELECT address,total_supply,decimals,quote_token,pair_address,graduated,market_cap_usd,liquidity_usd FROM tokens ORDER BY COALESCE(market_cap_usd,0) DESC,last_seen_ms DESC LIMIT 24").all<{ address: string; total_supply: string | null; decimals: number; quote_token: string | null; pair_address: string | null; graduated: number; market_cap_usd: number | null; liquidity_usd: number | null }>();
  const candidates: string[] = []; for (const item of ranked.slice(0, MARKET_LIMIT)) { const t = tokenAddress(item); if (t && !candidates.includes(t)) candidates.push(t); } for (const row of existing.results ?? []) if (!candidates.includes(row.address)) candidates.push(row.address);
  const now = Date.now(); let snapshots = 0;
  for (const token of candidates) {
    if (snapshots >= SNAPSHOT_LIMIT) break;
    const item = rankedByToken.get(token.toLowerCase()); const meta = await env.DB.prepare("SELECT address,total_supply,decimals,quote_token,pair_address,graduated,market_cap_usd,liquidity_usd FROM tokens WHERE address=?").bind(token).first<{ address: string; total_supply: string | null; decimals: number; quote_token: string | null; pair_address: string | null; graduated: number; market_cap_usd: number | null; liquidity_usd: number | null }>();
    const decimals = Number(meta?.decimals || item?.market_info?.decimals || item?.token_info?.decimals || 18);
    let cap = item ? marketCap(item, decimals) : 0; let px = item ? price(item) : 0; let liq = item ? liquidity(item) : 0; let vol = item ? volume5m(item) : 0; let hold = item ? holders(item) : 0;
    if (!(cap >= MIN_MARKET_CAP_USD) || !(px > 0)) {
      const chart = await fetchChart(token);
      if (chart.length) { const last = chart[chart.length - 1]; if (!(cap > 0)) cap = last.c; const supply = units(item?.market_info?.total_supply ?? item?.token_info?.total_supply, decimals) || (meta?.total_supply ? Number(BigInt(meta.total_supply)) / 10 ** decimals : 0); if (!(px > 0) && supply > 0) px = cap / supply; if (!(vol > 0)) vol = last.v; }
    }
    if (!(cap >= MIN_MARKET_CAP_USD) || !(px > 0)) continue;
    const q = quote(item || {}) || meta?.quote_token || "NADFUN"; const p = pair(item || {}) || meta?.pair_address || null;
    await env.DB.prepare(`INSERT INTO market_snapshots(token_address,ts_ms,price_usd,market_cap_usd,liquidity_usd,volume_5m_usd,buys_5m,sells_5m,holders,quote_token,buy_volume_usd,sell_volume_usd,source_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(token, now, px, cap, liq || Number(meta?.liquidity_usd || 0), vol, 0, 0, hold, q, 0, 0, Number(toBlock)).run();
    await env.DB.prepare("UPDATE tokens SET market_cap_usd=?,liquidity_usd=?,last_seen_ms=?,quote_token=COALESCE(?,quote_token),pair_address=COALESCE(?,pair_address),graduated=? WHERE address=?").bind(cap, liq || Number(meta?.liquidity_usd || 0), now, q, p, item ? graduated(item) : Number(meta?.graduated || 0), token).run(); snapshots++;
  }
  await env.CIEL_STATE.put(INDEXER_STATE_KEY, JSON.stringify({ nextBlock: (toBlock + 1n).toString(), latestBlock: latest.toString(), lastSnapshotCount: snapshots, lastRunMs: now } satisfies IndexerState));
  return { fromBlock, toBlock, creates: creates.length, buys: buys.length, sells: sells.length, graduates: graduates.length, syncs: syncs.length, snapshots, nextBlock: toBlock + 1n };
}
