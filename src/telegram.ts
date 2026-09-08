import type { Env } from "./index";
import { reportAfterNotification } from "./reporting";

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
};

function telegramUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN!.trim()}/${method}`;
}

async function telegramRequest(env: Env, method: string, body?: Record<string, unknown>): Promise<TelegramApiResponse> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(telegramUrl(env, method), {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text().catch(() => "");
  let payload: TelegramApiResponse = {};
  try { payload = raw ? JSON.parse(raw) as TelegramApiResponse : {}; } catch {}
  if (!response.ok || payload.ok !== true) {
    throw new Error(`Telegram ${method} failed: HTTP ${response.status}; code=${payload.error_code ?? "unknown"}; ${payload.description ?? raw.slice(0, 500)}`);
  }
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

export async function testTelegram(env: Env): Promise<{ ok: boolean; bot?: string; chat?: string; error?: string }> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured" };
  try {
    const me = await telegramRequest(env, "getMe");
    const username = (me.result as { username?: string } | undefined)?.username;
    const chat = await telegramRequest(env, "getChat", { chat_id: chatId });
    const chatInfo = chat.result as { title?: string; username?: string; first_name?: string; type?: string } | undefined;
    await sendTelegram(env, "🔌 Ciel Telegram test\nBot authentication, chat access, and message delivery are working.");
    return {
      ok: true,
      bot: username ? `@${username}` : undefined,
      chat: chatInfo?.title || chatInfo?.username || chatInfo?.first_name || chatInfo?.type || chatId
    };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 800) };
  }
}

export async function notifyTelegram(env: Env, text: string): Promise<void> {
  try {
    await sendTelegram(env, text);
    await reportAfterNotification(env, text, sendTelegram);
  } catch (error) {
    console.error(`Telegram notification failed: ${String(error).slice(0, 800)}`);
  }
}
