import { GoogleGenAI } from "@google/genai";
import type { Env } from "./index";
import { notifyTelegram } from "./telegram";

const CHAT_HISTORY_PREFIX = "ciel_telegram_chat_history:";
const CHAT_HISTORY_TTL_SECONDS = 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";
const RUNTIME_KEY = "ciel_runtime_state";
const FEED_HEALTH_KEY = "ciel_market_feed_health";

function trimText(value: unknown, max = 1200): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractTokens(value: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 6 || value == null) return [];
  if (Array.isArray(value)) {
    return value.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
  }
  if (typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["tokens", "data", "result", "items", "markets"]) {
    const found = extractTokens(object[key], depth + 1);
    if (found.length) return found;
  }
  return [];
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const text = value.trim().replace(/[$,\s]/g, "");
  if (!text) return 0;
  const match = text.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(K|M|B|T)?$/i);
  if (!match) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const base = Number(match[1]);
  const multiplier = match[2] ? ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[match[2].toUpperCase()] : 1;
  return Number.isFinite(base * multiplier) ? base * multiplier : 0;
}

function objectValue(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return null;
  const object = source as Record<string, unknown>;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
  }
  return null;
}

function tokenSymbol(item: Record<string, unknown>): string {
  const info = item.token_info;
  const symbol = objectValue(info, ["symbol"]);
  return typeof symbol === "string" && symbol.trim() ? symbol.trim() : "unknown";
}

function tokenAddress(item: Record<string, unknown>): string | null {
  const value = objectValue(item.token_info, ["token_id", "token_address", "tokenAddress"]) ||
    objectValue(item.market_info, ["token_id", "token_address", "tokenAddress"]);
  const text = typeof value === "string" ? value.trim() : "";
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text : null;
}

function marketCap(item: Record<string, unknown>): number {
  return num(objectValue(item.market_info, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"])) ||
    num(objectValue(item.token_info, ["market_cap_usd", "marketCapUsd", "market_cap", "marketCap", "fdv"]));
}

async function contextForChat(env: Env): Promise<string> {
  const parts: string[] = [];
  const feedRaw = await env.CIEL_STATE.get(RANKING_CACHE_KEY);
  const healthRaw = await env.CIEL_STATE.get(FEED_HEALTH_KEY);
  const runtimeRaw = await env.CIEL_STATE.get(RUNTIME_KEY);

  if (healthRaw) {
    try {
      const health = JSON.parse(healthRaw) as Record<string, unknown>;
      parts.push(`Feed health: ${JSON.stringify({
        source: health.source || null,
        fetchedAt: health.fetchedAt || 0,
        count: health.count || 0,
        validCount: health.validCount || 0,
        topMarketCapUsd: health.topMarketCapUsd || 0,
        topSymbol: health.topSymbol || null,
        monUsd: health.monUsd || 0,
        diagnostics: health.diagnostics || null
      })}`);
    } catch {}
  }

  if (feedRaw) {
    try {
      const tokens = extractTokens(JSON.parse(feedRaw));
      const markets = tokens
        .map(item => ({
          symbol: tokenSymbol(item),
          token: tokenAddress(item),
          marketCapUsd: marketCap(item)
        }))
        .filter(item => item.token && item.marketCapUsd > 0)
        .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
        .slice(0, 12);
      parts.push(`Top cached markets: ${JSON.stringify(markets)}`);
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
        lastIndexerDiscoveryCount: runtime.lastIndexerDiscoveryCount || 0,
        lastIndexerValidAddressCount: runtime.lastIndexerValidAddressCount || 0,
        d1Degraded: runtime.d1Degraded || false
      })}`);
    } catch {}
  }

  return parts.join("\n").slice(0, 7000) || "No live Ciel context is currently available.";
}

async function loadHistory(env: Env, chatId: string): Promise<Array<{ role: "user" | "model"; text: string }>> {
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

async function saveHistory(env: Env, chatId: string, history: Array<{ role: "user" | "model"; text: string }>): Promise<void> {
  await env.CIEL_STATE.put(
    `${CHAT_HISTORY_PREFIX}${chatId}`,
    JSON.stringify(history.slice(-MAX_HISTORY_MESSAGES)),
    { expirationTtl: CHAT_HISTORY_TTL_SECONDS }
  );
}

function keySlots(env: Env): string[] {
  return [
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
    env.GEMINI_API_KEY_5,
    env.GEMINI_API_KEY_6,
    env.GEMINI_API_KEY_7
  ].map(value => (value || "").trim()).filter(Boolean);
}

async function answerWithGemini(env: Env, history: Array<{ role: "user" | "model"; text: string }>, userText: string): Promise<string> {
  const keys = keySlots(env);
  if (!keys.length) throw new Error("No Gemini API key is configured");

  const context = await contextForChat(env);
  const prompt = [
    "You are Ciel, a crypto market intelligence assistant running on Nad.fun.",
    "Answer the user's Telegram question directly and naturally.",
    "Use the supplied live Ciel context when it is relevant. Never invent live prices, trades, balances, transactions, or decisions.",
    "You may explain Ciel's current state, market observations, model decisions, risk settings, or recent telemetry.",
    "Make clear when data is unavailable or stale. Keep responses under 3500 characters.",
    `LIVE CIEL CONTEXT:\n${context}`,
    `RECENT CHAT:\n${history.map(item => `${item.role === "user" ? "User" : "Ciel"}: ${item.text}`).join("\n") || "(none)"}`,
    `CURRENT USER MESSAGE:\n${userText}`
  ].join("\n\n");

  let lastError: unknown = null;
  for (const key of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: prompt
      });
      const text = trimText(response.text, 3500);
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Gemini request failed"));
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const update = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!update || typeof update !== "object") return new Response("Bad request", { status: 400 });

  const message = update.message && typeof update.message === "object"
    ? update.message as Record<string, unknown>
    : null;
  const chat = message?.chat && typeof message.chat === "object"
    ? message.chat as Record<string, unknown>
    : null;
  const chatId = chat?.id;
  const configuredChatId = env.TELEGRAM_CHAT_ID?.trim();

  if (chatId === undefined || chatId === null || String(chatId) !== configuredChatId) {
    return new Response("Ignored", { status: 200 });
  }

  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) return new Response("No text", { status: 200 });

  if (text === "/start" || text === "/help") {
    await notifyTelegram(env, "🤖 Ciel Gemini chat is online. Ask me about the market feed, Ciel's decisions, trading state, positions, or what the bot has seen recently.");
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
