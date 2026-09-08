import type { Env } from "./index";

type SendTelegram = (env: Env, text: string) => Promise<void>;

type PulseRow = {
  address: string;
  symbol: string | null;
  name: string | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  price_usd: number | null;
  previous_price_usd: number | null;
  volume_5m_usd: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  graduated: number | null;
};

type DiscoveryRow = {
  address: string;
  symbol: string | null;
  name: string | null;
  first_seen_ms: number;
  graduated: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
};

function money(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "$0.00";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function price(value: number | null | undefined): string {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(5)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function label(row: { symbol?: string | null; name?: string | null; address?: string; token_address?: string }): string {
  return row.symbol || row.name || shortAddress(row.address || row.token_address || "unknown");
}

function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export async function reportAfterNotification(env: Env, sourceText: string, send: SendTelegram): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    if (sourceText.startsWith("📡 Ciel indexer")) await sendMarketPulse(env, send);
    if (sourceText.startsWith("🧠 Ciel ")) await sendHourlyIntelligenceIfDue(env, send);
  } catch (error) {
    console.log(`Telegram reporting failed: ${String(error).slice(0, 300)}`);
  }
}

async function sendMarketPulse(env: Env, send: SendTelegram): Promise<void> {
  const rows = await env.DB.prepare(`
    SELECT
      t.address,t.symbol,t.name,t.market_cap_usd,t.liquidity_usd,t.graduated,
      s.price_usd,s.volume_5m_usd,s.buys_5m,s.sells_5m,
      (SELECT p.price_usd FROM market_snapshots p
       WHERE p.token_address=s.token_address AND p.ts_ms < s.ts_ms AND p.price_usd > 0
       ORDER BY p.ts_ms DESC LIMIT 1) AS previous_price_usd
    FROM tokens t
    JOIN market_snapshots s ON s.id=(
      SELECT x.id FROM market_snapshots x
      WHERE x.token_address=t.address AND x.price_usd > 0
      ORDER BY x.ts_ms DESC LIMIT 1
    )
    WHERE t.market_cap_usd > 0 AND t.liquidity_usd > 0
    ORDER BY t.market_cap_usd DESC, t.last_seen_ms DESC
    LIMIT 10
  `).all<PulseRow>();
  const top = rows.results ?? [];
  if (!top.length) return;

  const previousRanks = new Map<string, number>();
  const previous = await env.DB.prepare(`
    SELECT token_address, market_cap_usd,
      ROW_NUMBER() OVER (ORDER BY market_cap_usd DESC) AS rank
    FROM market_snapshots
    WHERE ts_ms=(SELECT MAX(ts_ms) FROM market_snapshots)
      AND market_cap_usd > 0
    ORDER BY market_cap_usd DESC LIMIT 50
  `).all<{ token_address: string; market_cap_usd: number; rank: number }>();
  for (const row of previous.results ?? []) previousRanks.set(row.token_address, Number(row.rank));

  const lines = top.map((row, index) => {
    const current = Number(row.price_usd || 0);
    const previousPrice = Number(row.previous_price_usd || 0);
    const change = previousPrice > 0 ? ((current - previousPrice) / previousPrice) * 100 : 0;
    const buys = Number(row.buys_5m || 0);
    const sells = Number(row.sells_5m || 0);
    const flow = buys + sells;
    const imbalance = flow ? ((buys - sells) / flow) * 100 : 0;
    const oldRank = previousRanks.get(row.address);
    const rankDelta = oldRank && oldRank !== index + 1 ? ` ${oldRank > index + 1 ? "↑" : "↓"}${Math.abs(oldRank - (index + 1))}` : "";
    const badge = row.graduated ? "✓" : "·";
    return `${String(index + 1).padStart(2, "0")}. ${badge} ${label(row).slice(0, 14).padEnd(14)} ${signedPct(change).padStart(7)} ${price(current).padStart(11)} MC ${money(row.market_cap_usd).padStart(9)} LQ ${money(row.liquidity_usd).padStart(8)}${rankDelta}\n    Vol ${money(row.volume_5m_usd)}  B/S ${buys}/${sells}  Flow ${signedPct(imbalance)}`;
  });

  const gainers = [...top].map(row => ({ row, change: Number(row.previous_price_usd) > 0 ? ((Number(row.price_usd) - Number(row.previous_price_usd)) / Number(row.previous_price_usd)) * 100 : 0 })).sort((a, b) => b.change - a.change).slice(0, 3);
  const losers = [...top].map(row => ({ row, change: Number(row.previous_price_usd) > 0 ? ((Number(row.price_usd) - Number(row.previous_price_usd)) / Number(row.previous_price_usd)) * 100 : 0 })).sort((a, b) => a.change - b.change).slice(0, 3);
  const discovery = await sendDiscoveryAlerts(env, send);
  const now = new Date().toISOString().replace("T", " ").replace(".000Z", " UTC");
  const message = [
    "📊 CIEL MARKET PULSE",
    `🕒 ${now}`,
    "",
    "TOP 10 MONITORED",
    ...lines,
    "",
    `🚀 Gainers: ${gainers.map(x => `${label(x.row)} ${signedPct(x.change)}`).join(" | ")}`,
    `🔻 Drops: ${losers.map(x => `${label(x.row)} ${signedPct(x.change)}`).join(" | ")}`,
    discovery,
    "",
    "ℹ️ Live trading remains OFF • Paper engine active"
  ].filter(Boolean).join("\n");
  await send(env, message.slice(0, 3900));
}

async function sendDiscoveryAlerts(env: Env, send: SendTelegram): Promise<string> {
  const cursorRaw = await env.CIEL_STATE.get("telegram_discovery_cursor_ms");
  const cursor = Number(cursorRaw || "0");
  const now = Date.now();
  const rows = await env.DB.prepare(`SELECT address,symbol,name,first_seen_ms,graduated,market_cap_usd,liquidity_usd FROM tokens WHERE first_seen_ms > ? AND first_seen_ms <= ? ORDER BY first_seen_ms ASC LIMIT 12`).bind(cursor, now).all<DiscoveryRow>();
  if (!rows.results?.length) {
    if (!cursorRaw) await env.CIEL_STATE.put("telegram_discovery_cursor_ms", String(now));
    return "🔎 Discoveries: none since last pulse";
  }
  await env.CIEL_STATE.put("telegram_discovery_cursor_ms", String(Math.max(...rows.results.map(r => r.first_seen_ms), cursor)));
  const text = rows.results.map(r => `• ${label(r)} ${r.graduated ? "✓ graduated" : "new"} | MC ${money(r.market_cap_usd)} | LQ ${money(r.liquidity_usd)} | ${shortAddress(r.address)}`).join("\n");
  return `🔎 DISCOVERIES (${rows.results.length})\n${text}`;
}

async function sendHourlyIntelligenceIfDue(env: Env, send: SendTelegram): Promise<void> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = String(hour);
  if (await env.CIEL_STATE.get("telegram_hourly_report") === key) return;
  const signals = await env.DB.prepare(`SELECT s.id,s.token_address,s.action,s.confidence,s.anomaly_score,s.model,s.rationale,t.symbol,t.name FROM signals s LEFT JOIN tokens t ON t.address=s.token_address ORDER BY s.ts_ms DESC LIMIT 12`).all<{ id: number; token_address: string; action: string; confidence: number; anomaly_score: number; model: string; rationale: string; symbol: string | null; name: string | null }>();
  const anomalies = (signals.results ?? []).filter(s => Number(s.anomaly_score || 0) >= 0.45).slice(0, 6);
  const buys = (signals.results ?? []).filter(s => s.action === "BUY").slice(0, 5);
  const sells = (signals.results ?? []).filter(s => s.action === "SELL").slice(0, 5);
  const positions = await env.DB.prepare(`SELECT p.token_address,p.quantity,p.entry_price_usd,p.last_price_usd,t.symbol,t.name,t.decimals FROM positions p LEFT JOIN tokens t ON t.address=p.token_address WHERE p.quantity <> '0' ORDER BY p.updated_ts_ms DESC LIMIT 8`).all<{ token_address: string; quantity: string; entry_price_usd: number; last_price_usd: number; symbol: string | null; name: string | null; decimals: number }>();
  const balance = Number(await env.CIEL_STATE.get("paper_balance_mon") || "100");
  const realized = Number(await env.CIEL_STATE.get("paper_realized_pnl_usd") || "0");
  const unrealized = Number(await env.CIEL_STATE.get("paper_unrealized_pnl_usd") || "0");
  const totalPnl = realized + unrealized;
  const monUsd = Number(await env.CIEL_STATE.get("mon_usd") || "0");
  const circuit = (await env.CIEL_STATE.get("paper_execution_circuit_open")) === "true";
  const failures = Number(await env.CIEL_STATE.get("paper_execution_failure_count") || "0");
  const positionLines = (positions.results ?? []).map(p => {
    const decimals = Number(p.decimals || 18);
    const qty = Number(BigInt(p.quantity)) / 10 ** decimals;
    const pnl = (Number(p.last_price_usd || 0) - Number(p.entry_price_usd || 0)) * qty;
    return `• ${label(p)} | ${money(Number(p.last_price_usd || 0))} | uPnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
  });
  const signalLines = (signals.results ?? []).slice(0, 6).map(s => `• ${s.action.padEnd(6)} ${label(s)} | ${(Number(s.confidence || 0) * 100).toFixed(0)}% | A ${Number(s.anomaly_score || 0).toFixed(2)} | ${s.model}`);
  const anomalyLines = anomalies.length ? anomalies.map(s => `• ${label(s)} | ${s.action} | anomaly ${Number(s.anomaly_score || 0).toFixed(2)} | ${String(s.rationale || "").slice(0, 120)}`) : ["• No high-score anomalies in latest signals"];
  const topBuys = buys.length ? buys.map(s => `${label(s)} ${(Number(s.confidence || 0) * 100).toFixed(0)}%`).join(" | ") : "none";
  const topSells = sells.length ? sells.map(s => `${label(s)} ${(Number(s.confidence || 0) * 100).toFixed(0)}%`).join(" | ") : "none";
  const message = [
    "🧠 CIEL HOURLY INTELLIGENCE",
    `🕒 ${new Date().toISOString().replace("T", " ").replace(".000Z", " UTC")}`,
    "",
    "GEMINI / SIGNAL BOARD",
    ...(signalLines.length ? signalLines : ["• No recent signals"]),
    "",
    `🟢 BUY: ${topBuys}`,
    `🔴 SELL: ${topSells}`,
    "",
    "⚠️ ANOMALIES",
    ...anomalyLines,
    "",
    "📒 PAPER PORTFOLIO",
    `Balance: ${balance.toFixed(4)} MON (${money(balance * monUsd)})`,
    `Realized P&L: ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)}`,
    `Unrealized P&L: ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)}`,
    `Total P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
    `Open positions: ${(positions.results ?? []).length}`,
    ...(positionLines.length ? positionLines : ["• No open paper positions"]),
    "",
    `🛡️ Execution circuit: ${circuit ? "OPEN — blocked" : "CLOSED — normal"} | failures ${failures}`,
    "🔒 Live trading: OFF"
  ].join("\n");
  await send(env, message.slice(0, 3900));
  await env.CIEL_STATE.put("telegram_hourly_report", key);
}
