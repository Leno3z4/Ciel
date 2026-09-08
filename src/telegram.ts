import type { Env } from "./index";
import { reportAfterNotification } from "./reporting";

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured");
    return;
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram notification failed: ${response.status} ${body.slice(0, 300)}`);
  }
}

export async function notifyTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram notification skipped: required secrets are missing");
    return;
  }
  try {
    await sendTelegram(env, text);
    await reportAfterNotification(env, text, sendTelegram);
  } catch (error) {
    console.error(`Telegram notification failed: ${String(error).slice(0, 500)}`);
  }
}
