import type { Env } from "./index";
import { reportAfterNotification } from "./reporting";

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
};

const TELEGRAM_RUNTIME_KEY = "ciel_telegram_runtime";
type TelegramRuntime = { lastAttemptAt?: number; lastSuccessAt?: number; lastFailureAt?: number; lastError?: string; lastTestAt?: number; lastTestSuccess?: boolean };

async function recordTelegramRuntime(env: Env, patch: TelegramRuntime): Promise<void> {
  try {
    const raw = await env.CIEL_STATE.get(TELEGRAM_RUNTIME_KEY);
    let current: TelegramRuntime = {};
    try { if (raw) current = JSON.parse(raw) as TelegramRuntime; } catch {}
    await env.CIEL_STATE.put(TELEGRAM_RUNTIME_KEY, JSON.stringify({ ...current, ...patch }));
  } catch (error) { console.error(`Telegram telemetry write failed: ${String(error).slice(0, 300)}`); }
}

function telegramUrl(env: Env, method: string): string { return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN!.trim()}/${method}`; }

async function telegramRequest(env: Env, method: string, body?: Record<string, unknown>): Promise<TelegramApiResponse> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(telegramUrl(env, method), { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const raw = await response.text().catch(() => "");
  let payload: TelegramApiResponse = {};
  try { payload = raw ? JSON.parse(raw) as TelegramApiResponse : {}; } catch {}
  if (!response.ok || payload.ok !== true) throw new Error(`Telegram ${method} failed: HTTP ${response.status}; code=${payload.error_code ?? "unknown"}; ${payload.description ?? raw.slice(0, 500)}`);
  return payload;
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured");
  if (!text.trim()) throw new Error("Telegram message text is empty");
  if (text.length > 4096) throw new Error(`Telegram message is too long: ${text.length} characters`);
  await telegramRequest(env, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

function fmtUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function fmtPct(value: number | null): string {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(1)}%` : "n/a";
}

async function transformIndexerNotification(env: Env, text: string): Promise<string> {
  if (!text.startsWith("📡 Ciel indexer")) return text;
  try {
    const established = await env.DB.prepare(`SELECT COUNT(*) as count FROM (SELECT token_address FROM market_snapshots WHERE price_usd>0 GROUP BY token_address HAVING COUNT(*)>=12 AND (MAX(ts_ms)-MIN(ts_ms))>=1800000 AND AVG(volume_5m_usd)>=5000 AND AVG(liquidity_usd)>=10000 AND AVG(market_cap_usd)>=90000)`).first<{ count: number }>();
    const rows = await env.DB.prepare(`SELECT s.token_address as token, t.symbol as symbol, s.market_cap_usd as cap,
      ((s.market_cap_usd - COALESCE((SELECT h.market_cap_usd FROM market_snapshots h WHERE h.token_address=s.token_address AND h.ts_ms<=s.ts_ms-1800000 AND h.market_cap_usd>0 ORDER BY h.ts_ms DESC LIMIT 1),s.market_cap_usd)) / NULLIF((SELECT h.market_cap_usd FROM market_snapshots h WHERE h.token_address=s.token_address AND h.ts_ms<=s.ts_ms-1800000 AND h.market_cap_usd>0 ORDER BY h.ts_ms DESC LIMIT 1),0))*100 as ret30,
      ((s.market_cap_usd - COALESCE((SELECT h.market_cap_usd FROM market_snapshots h WHERE h.token_address=s.token_address AND h.ts_ms<=s.ts_ms-7200000 AND h.market_cap_usd>0 ORDER BY h.ts_ms DESC LIMIT 1),s.market_cap_usd)) / NULLIF((SELECT h.market_cap_usd FROM market_snapshots h WHERE h.token_address=s.token_address AND h.ts_ms<=s.ts_ms-7200000 AND h.market_cap_usd>0 ORDER BY h.ts_ms DESC LIMIT 1),0))*100 as ret2h
      FROM market_snapshots s LEFT JOIN tokens t ON t.address=s.token_address
      WHERE s.ts_ms=(SELECT MAX(x.ts_ms) FROM market_snapshots x WHERE x.token_address=s.token_address) AND s.market_cap_usd>=90000
      ORDER BY s.market_cap_usd DESC LIMIT 5`).all<{ token: string; symbol: string | null; cap: number; ret30: number | null; ret2h: number | null }>();
    if (!(rows.results?.length)) return "📊 Ciel market monitor\nEstablished markets: 0\nMarket-cap floor: ≥$90,000\n\nNo qualifying market-cap snapshots yet. Ciel is still building history.";
    const top = (rows.results || []).map((row, i) => `${i + 1}. ${row.symbol || row.token.slice(0, 10)} — ${fmtUsd(Number(row.cap))} | ${fmtPct(row.ret30)} 30m | ${fmtPct(row.ret2h)} 2h`);
    return `📊 Ciel market monitor\nEstablished markets: ${Number(established?.count || 0)}\nMarket-cap floor: ≥$90,000\n\nTop markets\n${top.join("\n")}`.slice(0, 3900);
  } catch (error) {
    console.error(`Market monitor Telegram formatting failed: ${String(error).slice(0, 500)}`);
    return "📊 Ciel market monitor\nMarket-cap floor: ≥$90,000\n\nMarket snapshot data is not available yet; Ciel is still building its history.";
  }
}

export async function testTelegram(env: Env): Promise<{ ok: boolean; bot?: string; chat?: string; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const testedAt = Date.now();
  if (!token || !chatId) {
    await recordTelegramRuntime(env, { lastTestAt: testedAt, lastTestSuccess: false, lastError: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured" });
    return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured" };
  }
  try {
    const me = await telegramRequest(env, "getMe");
    const username = (me.result as { username?: string } | undefined)?.username;
    const chat = await telegramRequest(env, "getChat", { chat_id: chatId });
    const chatInfo = chat.result as { title?: string; username?: string; first_name?: string; type?: string } | undefined;
    await sendTelegram(env, "🔌 Ciel Telegram test\nBot authentication, chat access, and message delivery are working.");
    await recordTelegramRuntime(env, { lastTestAt: testedAt, lastTestSuccess: true, lastSuccessAt: Date.now(), lastError: undefined });
    return { ok: true, bot: username ? `@${username}` : undefined, chat: chatInfo?.title || chatInfo?.username || chatInfo?.first_name || chatInfo?.type || chatId };
  } catch (error) {
    const message = String(error).slice(0, 800);
    await recordTelegramRuntime(env, { lastTestAt: testedAt, lastTestSuccess: false, lastFailureAt: Date.now(), lastError: message });
    return { ok: false, error: message };
  }
}

export async function notifyTelegram(env: Env, text: string): Promise<void> {
  await recordTelegramRuntime(env, { lastAttemptAt: Date.now() });
  try {
    const outgoing = await transformIndexerNotification(env, text);
    await sendTelegram(env, outgoing);
    await recordTelegramRuntime(env, { lastSuccessAt: Date.now(), lastError: undefined });
    await reportAfterNotification(env, outgoing, sendTelegram);
  } catch (error) {
    const message = String(error).slice(0, 800);
    await recordTelegramRuntime(env, { lastFailureAt: Date.now(), lastError: message });
    console.error(`Telegram notification failed: ${message}`);
  }
}
