import type { Env } from "./index";

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: unknown;
};

const TELEGRAM_RUNTIME_KEY = "ciel_telegram_runtime";
const RUNTIME_KEY = "ciel_runtime_state";
const RANKING_CACHE_KEY = "nadfun_market_ranking_cache";

type TelegramRuntime = {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  lastTestAt?: number;
  lastTestSuccess?: boolean;
};

type FeedToken = {
  token_info?: Record<string, unknown>;
  market_info?: Record<string, unknown>;
  [key: string]: unknown;
};

async function recordTelegramRuntime(env: Env, patch: TelegramRuntime): Promise<void> {
  try {
    const raw = await env.CIEL_STATE.get(TELEGRAM_RUNTIME_KEY);
    let current: TelegramRuntime = {};
    try {
      if (raw) current = JSON.parse(raw) as TelegramRuntime;
    } catch {}

    await env.CIEL_STATE.put(
      TELEGRAM_RUNTIME_KEY,
      JSON.stringify({ ...current, ...patch })
    );
  } catch (error) {
    console.error(
      `Telegram telemetry write failed: ${String(error).slice(0, 300)}`
    );
  }
}

function telegramUrl(env: Env, method: string): string {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN!.trim()}/${method}`;
}

async function telegramRequest(
  env: Env,
  method: string,
  body?: Record<string, unknown>
): Promise<TelegramApiResponse> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim()) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    telegramUrl(env, method),
    {
      method: body ? "POST" : "GET",
      headers: body
        ? { "content-type": "application/json" }
        : undefined,
      body: body ? JSON.stringify(body) : undefined
    }
  );

  const raw = await response.text().catch(() => "");
  let payload: TelegramApiResponse = {};

  try {
    payload = raw
      ? JSON.parse(raw) as TelegramApiResponse
      : {};
  } catch {}

  if (!response.ok || payload.ok !== true) {
    throw new Error(
      `Telegram ${method} failed: HTTP ${response.status}; code=${payload.error_code ?? "unknown"}; ${payload.description ?? raw.slice(0, 500)}`
    );
  }

  return payload;
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !chatId) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured"
    );
  }

  if (!text.trim()) {
    throw new Error("Telegram message text is empty");
  }

  if (text.length > 4096) {
    throw new Error(
      `Telegram message is too long: ${text.length} characters`
    );
  }

  await telegramRequest(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    }
  );
}

function num(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value !== "string") return 0;

  const text = value.trim().replace(/[$,\s]/g, "");
  if (!text) return 0;

  const match = text.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(K|M|B|T)?$/i
  );

  if (!match) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;

  const multipliers: Record<string, number> = {
    K: 1e3,
    M: 1e6,
    B: 1e9,
    T: 1e12
  };

  return base * (
    match[2]
      ? multipliers[match[2].toUpperCase()]
      : 1
  );
}

function objectValue(
  source: unknown,
  keys: string[]
): unknown {
  if (!source || typeof source !== "object") return null;

  const obj = source as Record<string, unknown>;

  for (const key of keys) {
    if (
      obj[key] !== undefined &&
      obj[key] !== null &&
      obj[key] !== ""
    ) {
      return obj[key];
    }
  }

  return null;
}

function nestedNumber(
  item: FeedToken,
  tokenKeys: string[],
  marketKeys: string[]
): number {
  return num(
    objectValue(item.market_info, marketKeys)
  ) || num(
    objectValue(item.token_info, tokenKeys)
  );
}

function tokenAddress(item: FeedToken): string | null {
  const value =
    objectValue(item.token_info, [
      "token_id",
      "token_address",
      "tokenAddress"
    ]) ||
    objectValue(item.market_info, [
      "token_id",
      "token_address",
      "tokenAddress"
    ]);

  const text = typeof value === "string"
    ? value
    : "";

  return /^0x[a-fA-F0-9]{40}$/.test(text)
    ? text.toLowerCase()
    : null;
}

function extractTokens(
  value: unknown,
  depth = 0
): FeedToken[] {
  if (depth > 6 || value == null) return [];

  if (Array.isArray(value)) {
    return value.filter(
      item => item && typeof item === "object"
    ) as FeedToken[];
  }

  if (typeof value !== "object") return [];

  const object = value as Record<string, unknown>;

  for (const key of [
    "tokens",
    "data",
    "result",
    "items",
    "markets"
  ]) {
    const found = extractTokens(
      object[key],
      depth + 1
    );

    if (found.length) return found;
  }

  return [];
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function feedMarketCap(item: FeedToken): number {
  return nestedNumber(
    item,
    [
      "market_cap_usd",
      "marketCapUsd",
      "market_cap",
      "marketCap",
      "fdv"
    ],
    [
      "market_cap_usd",
      "marketCapUsd",
      "market_cap",
      "marketCap",
      "fdv"
    ]
  );
}

function feedLiquidity(item: FeedToken): number {
  return nestedNumber(
    item,
    ["liquidity_usd", "liquidityUsd"],
    ["liquidity_usd", "liquidityUsd"]
  );
}

function feedSymbol(item: FeedToken): string {
  const symbol = objectValue(
    item.token_info,
    ["symbol"]
  );

  return typeof symbol === "string" && symbol.trim()
    ? symbol.trim()
    : tokenAddress(item)?.slice(0, 10) || "unknown";
}

async function readRuntime(
  env: Env
): Promise<Record<string, unknown>> {
  const raw = await env.CIEL_STATE.get(RUNTIME_KEY);
  if (!raw) return {};

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readCachedMarkets(
  env: Env
): Promise<FeedToken[]> {
  const raw = await env.CIEL_STATE.get(
    RANKING_CACHE_KEY
  );

  if (!raw) return [];

  try {
    return extractTokens(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function transformIndexerNotification(
  env: Env,
  text: string
): Promise<string> {
  if (!text.startsWith("📡 Ciel indexer")) {
    return text;
  }

  try {
    const runtime = await readRuntime(env);
    const markets = await readCachedMarkets(env);

    const ranked = markets
      .map(item => ({
        item,
        marketCap: feedMarketCap(item),
        liquidity: feedLiquidity(item)
      }))
      .filter(row => row.marketCap > 0)
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, 5);

    const discoveryCount = Number(
      runtime.lastIndexerDiscoveryCount || 0
    );
    const candidateCount = Number(
      runtime.lastIndexerCandidateCount || 0
    );
    const directEligible = Number(
      runtime.lastIndexerDirectEligible || 0
    );
    const capEligible = Number(
      runtime.lastIndexerCapEligible || 0
    );

    const marketLines = ranked.map(
      (row, index) =>
        `${index + 1}. ${feedSymbol(row.item)} — MC ${formatUsd(row.marketCap)} | LQ ${formatUsd(row.liquidity)}`
    );

    const marketSection = marketLines.length
      ? `\n\nTOP CURRENT MARKETS\n${marketLines.join("\n")}`
      : "";

    return [
      "📡 CIEL INDEXER UPDATE",
      text.replace("📡 Ciel indexer", "").trim(),
      `Discovery: ${discoveryCount} | Candidates: ${candidateCount} | ≥$90K: ${capEligible} | Direct eligible: ${directEligible}`,
      marketSection
    ].filter(Boolean).join("\n").slice(0, 3900);
  } catch (error) {
    console.error(
      `Market monitor Telegram formatting failed: ${String(error).slice(0, 500)}`
    );

    return text;
  }
}

export async function testTelegram(
  env: Env
): Promise<{
  ok: boolean;
  bot?: string;
  chat?: string;
  error?: string;
}> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const testedAt = Date.now();

  if (!token || !chatId) {
    await recordTelegramRuntime(
      env,
      {
        lastTestAt: testedAt,
        lastTestSuccess: false,
        lastError:
          "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured"
      }
    );

    return {
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured"
    };
  }

  try {
    const me = await telegramRequest(env, "getMe");
    const username = (
      me.result as { username?: string } | undefined
    )?.username;

    const chat = await telegramRequest(
      env,
      "getChat",
      { chat_id: chatId }
    );

    const chatInfo = chat.result as {
      title?: string;
      username?: string;
      first_name?: string;
      type?: string;
    } | undefined;

    await sendTelegram(
      env,
      "🔌 Ciel Telegram test\nBot authentication, chat access, and message delivery are working."
    );

    await recordTelegramRuntime(
      env,
      {
        lastTestAt: testedAt,
        lastTestSuccess: true,
        lastSuccessAt: Date.now(),
        lastError: undefined
      }
    );

    return {
      ok: true,
      bot: username ? `@${username}` : undefined,
      chat:
        chatInfo?.title ||
        chatInfo?.username ||
        chatInfo?.first_name ||
        chatInfo?.type ||
        chatId
    };
  } catch (error) {
    const message = String(error).slice(0, 800);

    await recordTelegramRuntime(
      env,
      {
        lastTestAt: testedAt,
        lastTestSuccess: false,
        lastFailureAt: Date.now(),
        lastError: message
      }
    );

    return {
      ok: false,
      error: message
    };
  }
}

export async function notifyTelegram(
  env: Env,
  text: string
): Promise<void> {
  await recordTelegramRuntime(
    env,
    { lastAttemptAt: Date.now() }
  );

  try {
    const outgoing = await transformIndexerNotification(
      env,
      text
    );

    await sendTelegram(env, outgoing);

    await recordTelegramRuntime(
      env,
      {
        lastSuccessAt: Date.now(),
        lastError: undefined
      }
    );
  } catch (error) {
    const message = String(error).slice(0, 800);

    await recordTelegramRuntime(
      env,
      {
        lastFailureAt: Date.now(),
        lastError: message
      }
    );

    console.error(
      `Telegram notification failed: ${message}`
    );
  }
}
