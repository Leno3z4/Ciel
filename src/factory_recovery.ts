import { publicClient, NADFUN_FACTORY, WMON, LVMON } from "./nadfun";
import type { Env } from "./index";

const RECOVERY_STATE_KEY = "ciel_factory_recovery_last_ms";
const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;
const FACTORY_PAIR_LIMIT = 48;
const CHART_LIMIT = 48;
const MIN_MARKET_CAP_USD = 90_000;

const factoryAbi = [
  { type: "function", name: "allPairsLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allPairs", stateMutability: "view", inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "address" }] }
] as const;

const pairAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }
] as const;

const tokenAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
] as const;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureTokensTable(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY,symbol TEXT,name TEXT,market_cap_usd REAL,liquidity_usd REAL,first_seen_ms INTEGER NOT NULL,last_seen_ms INTEGER NOT NULL,total_supply TEXT,decimals INTEGER NOT NULL DEFAULT 18,quote_token TEXT,pair_address TEXT,graduated INTEGER NOT NULL DEFAULT 0,created_at_block INTEGER)`).run();
}

async function fetchMarketCap(token: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 7 * 24 * 3600;
  try {
    const response = await fetch(`https://api.nadapp.net/trade/chart/${token}?resolution=60&from=${from}&to=${now}&countback=168&chart_type=market_cap_usd`, { headers: { Accept: "application/json", "User-Agent": "Ciel-NadFun/2.0" }, cf: { cacheTtl: 300 } });
    if (!response.ok) return 0;
    const data = await response.json() as { s?: string; c?: unknown[] };
    if (data.s !== "ok" || !Array.isArray(data.c) || !data.c.length) return 0;
    return n(data.c[data.c.length - 1]);
  } catch {
    return 0;
  }
}

export async function recoverFactoryMarkets(env: Env): Promise<void> {
  const lastRun = n(await env.CIEL_STATE.get(RECOVERY_STATE_KEY));
  if (lastRun > 0 && Date.now() - lastRun < RECOVERY_INTERVAL_MS) return;
  await ensureTokensTable(env);

  const client = publicClient(env.NAD_RPC_URL);
  let total = 0;
  try {
    total = Number(await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairsLength" }));
  } catch (error) {
    console.error(`Factory recovery length read failed: ${String(error).slice(0, 300)}`);
    return;
  }

  const start = Math.max(0, total - FACTORY_PAIR_LIMIT);
  const tokens: Array<{ token: string; pair: string; quote: string; supply: string | null; decimals: number }> = [];

  for (let i = total - 1; i >= start; i--) {
    try {
      const pair = await client.readContract({ address: NADFUN_FACTORY, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] });
      const [token0, token1] = await Promise.all([
        client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
        client.readContract({ address: pair, abi: pairAbi, functionName: "token1" })
      ]);
      const token0IsQuote = token0.toLowerCase() === WMON.toLowerCase() || token0.toLowerCase() === LVMON.toLowerCase();
      const token1IsQuote = token1.toLowerCase() === WMON.toLowerCase() || token1.toLowerCase() === LVMON.toLowerCase();
      if (!token0IsQuote && !token1IsQuote) continue;
      const token = token0IsQuote ? token1 : token0;
      const quote = token0IsQuote ? token0 : token1;
      const [supply, decimals] = await Promise.all([
        client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" }).catch(() => null),
        client.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }).catch(() => 18)
      ]);
      tokens.push({ token, pair, quote, supply: supply?.toString() ?? null, decimals: Number(decimals) });
    } catch (error) {
      console.error(`Factory recovery pair ${i} failed: ${String(error).slice(0, 200)}`);
    }
  }

  const seen = new Set<string>();
  for (const item of tokens) {
    const key = item.token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO tokens(address,symbol,name,market_cap_usd,liquidity_usd,first_seen_ms,last_seen_ms,total_supply,decimals,quote_token,pair_address,graduated,created_at_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,total_supply=COALESCE(excluded.total_supply,tokens.total_supply),decimals=excluded.decimals,quote_token=excluded.quote_token,pair_address=excluded.pair_address,graduated=1`).bind(item.token, null, null, 0, 0, now, now, item.supply, Math.max(0, item.decimals), item.quote, item.pair, 1).run();
  }

  for (let i = 0; i < Math.min(CHART_LIMIT, tokens.length); i += 8) {
    const batch = tokens.slice(i, i + 8);
    const caps = await Promise.all(batch.map(async item => ({ ...item, cap: await fetchMarketCap(item.token) })));
    for (const item of caps) {
      if (!(item.cap >= MIN_MARKET_CAP_USD)) continue;
      await env.DB.prepare("UPDATE tokens SET market_cap_usd=?,last_seen_ms=?,graduated=1 WHERE address=?").bind(item.cap, Date.now(), item.token).run();
    }
  }

  await env.CIEL_STATE.put(RECOVERY_STATE_KEY, String(Date.now()), { expirationTtl: 86400 });
}
