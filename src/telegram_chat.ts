import { GoogleGenAI } from "@google/genai";
import type { Env } from "./index";
import { notifyTelegram } from "./telegram";
import { getMarketState } from "./market_discovery";

const CHAT_HISTORY_PREFIX = "ciel_telegram_chat_history:";
const CHAT_HISTORY_TTL_SECONDS = 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;
const RUNTIME_KEY = "ciel_runtime_state";
const HOT_STATE_KEY = "ciel_hot_intelligence_state";
const CHAT_KEY_INDEX = 7;

type GeminiEnv = Env & Record<string, unknown>;

function trimText(value: unknown, max = 1200): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function contextForChat(env: GeminiEnv): Promise<string> {
  const parts: string[] = [];
  const marketState = await getMarketState(env);
  const runtimeRaw = await env.CIEL_STATE.get(RUNTIME_KEY);
  const hotRaw = await env.CIEL_STATE.get(HOT_STATE_KEY);

  if (marketState) {
    parts.push(`Market feed: ${JSON.stringify({
      source: marketState.source || null,
      fetchedAt: marketState.fetchedAt || 0,
      count: marketState.tokens?.length || 0,
      monUsd: marketState.monUsd || 0,
      topMarkets: (marketState.ranked || []).slice(0, 12)
    })}`);
  }

  if (hotRaw) {
    try {
      const hot = JSON.parse(hotRaw) as Record<string, unknown>;
      const markets = hot.markets && typeof hot.markets === "object" ? hot.markets as Record<string, unknown> : {};
      const hotSummary = Object.entries(markets).slice(0, 5).map(([token, value]) => {
        const market = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const snapshots = Array.isArray(market.snapshots) ? market.snapshots as Array<Record<string, unknown>> : [];
        const latest = snapshots[0] || {};
        return {
          token,
          samples: snapshots.length,
          currentPriceUsd: num(latest.priceUsd),
          currentMarketCapUsd: num(latest.marketCapUsd)
        };
      });
      parts.push(`Hot intelligence summary: ${JSON.stringify(hotSummary)}`);
    } catch {}
  }

  if (runtimeRaw) {
    try {
      const runtime = JSON.parse(runtimeRaw) as Record<string, unknown>;
      parts.push(`Ciel runtime: ${JSON.stringify({
        lastModelAnalyzed: runtime.lastModelAnalyzed || 0,
        lastModelError: runtime.lastModelError || null,
        lastGeminiSuccess: runtime.lastGeminiSuccess || 0,
        lastGeminiError: runtime.lastGeminiError || null,
        lastModelDecisionCandidate: runtime.lastModelDecisionCandidate || null,
        lastModelDecisionAction: runtime.lastModelDecisionAction || null,
        lastModelDecisionConfidence: runtime.lastModelDecisionConfidence || 0,
        lastKvIntelligenceRun: runtime.lastKvIntelligenceRun || 0,
        lastKvIntelligenceAnalyzed: runtime.lastKvIntelligenceAnalyzed || 0,
        lastLivePositionGuard: runtime.lastLivePositionGuard || 0,
        lastLivePositionGuardChecked: runtime.lastLivePositionGuardChecked || 0,
        lastLivePositionGuardExited: runtime.lastLivePositionGuardExited || 0,
        lastLivePositionGuardWarning: runtime.lastLivePositionGuardWarning || null
      })}`);
    } catch {}
  }

  return parts.join("\n").slice(0, 7000) || "No live Ciel context is currently available.";
}

async function loadHistory(env: GeminiEnv, chatId: string): Promise<Array<{ role: "user" | "model"; text: string }>> {
  const raw = await env.CIEL_STATE.get(`${CHAT_HISTORY_PREFIX}${chatId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ role?: string; text?: unknown }>;
    return parsed
      .filter(item => (item.role === "user" || item.role === "model") && typeof item.text === "string")
      .map(item => ({ role: item.role as "user" | "model", text: trimText(item.text, 2000) }))
      .slice(-MAX_HISTORY_MESSAGES);
  } catch {
    return [];
  }
}

async function saveHistory(env: GeminiEnv, chatId: string, history: Array<{ role: "user" | "model"; text: string }>): Promise<void> {
  await env.CIEL_STATE.put(
    `${CHAT_HISTORY_PREFIX}${chatId}`,
    JSON.stringify(history.slice(-MAX_HISTORY_MESSAGES)),
    { expirationTtl: CHAT_HISTORY_TTL_SECONDS }
  );
}

async function answerWithGemini(
  env: GeminiEnv,
  history: Array<{ role: "user" | "model"; text: string }>,
  userText: string
): Promise<string> {
  const key = String(env[`GEMINI_API_KEY_${CHAT_KEY_INDEX}`] || "").trim();
  if (!key) throw new Error(`GEMINI_API_KEY_${CHAT_KEY_INDEX} is not configured for Telegram chat`);

  const context = await contextForChat(env);
  const prompt = [
    "You are Ciel, a crypto market intelligence assistant running on Nad.fun.",
    "Answer the user's Telegram question directly and naturally.",
    "Use the supplied live Ciel context when it is relevant. Never invent live prices, trades, balances, transactions, or decisions.",
    "You may explain Ciel's current state, market observations, model decisions, risk settings, positions, exits, or recent telemetry.",
    "Make clear when data is unavailable or stale. Keep responses under 3500 characters.",
    `LIVE CIEL CONTEXT:\n${context}`,
    `RECENT CHAT:\n${history.map(item => `${item.role === "user" ? "User" : "Ciel"}: ${item.text}`).join("\n") || "(none)"}`,
    `CURRENT USER MESSAGE:\n${userText}`
  ].join("\n\n");

  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({ model: env.GEMINI_MODEL, contents: prompt });
  const text = trimText(response.text, 3500);
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

export async function handleTelegramWebhook(request: Request, env: GeminiEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const update = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!update || typeof update !== "object") return new Response("Bad request", { status: 400 });

  const message = update.message && typeof update.message === "object" ? update.message as Record<string, unknown> : null;
  const chat = message?.chat && typeof message.chat === "object" ? message.chat as Record<string, unknown> : null;
  const chatId = chat?.id;
  const configuredChatId = env.TELEGRAM_CHAT_ID?.trim();

  if (chatId === undefined || chatId === null || String(chatId) !== configuredChatId) return new Response("Ignored", { status: 200 });

  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) return new Response("No text", { status: 200 });

  if (text === "/start" || text === "/help") {
    await notifyTelegram(env, "🤖 Ciel Gemini chat is online. Ask me about the market feed, Ciel's decisions, trading state, positions, exits, or what the bot has seen recently.");
    return new Response("ok", { status: 200 });
  }

  if (text === "/clear") {
    await env.CIEL_STATE.delete(`${CHAT_HISTORY_PREFIX}${chatId}`);
    await notifyTelegram(env, "🧹 Ciel chat memory cleared.");
    return new Response("ok", { status: 200 });
  }

  try {
    const history = await loadHistory(env, String(chatId));
    const reply = await answerWithGemini(env, history, text);
    await saveHistory(env, String(chatId), [
      ...history,
      { role: "user", text: trimText(text, 2000) },
      { role: "model", text: reply }
    ]);
    await notifyTelegram(env, reply);
  } catch (error) {
    await notifyTelegram(env, `⚠️ Gemini chat error: ${trimText(String(error), 900)}`);
  }

  return new Response("ok", { status: 200 });
}
