import type { Env } from "./index";

export type GeminiPool = "ANALYST" | "DECISION" | "FALLBACK";

export interface GeminiKeySlot {
  index: number;
  key: string;
}

const POOL_ORDER: Record<GeminiPool, number[]> = {
  ANALYST: [1, 2],
  DECISION: [3, 4, 5, 6],
  FALLBACK: [7]
};

export const GEMINI_POOL_LABELS: Record<GeminiPool, string> = {
  ANALYST: "market analyst (keys 1-2)",
  DECISION: "decision engine (keys 3-6)",
  FALLBACK: "emergency fallback (key 7)"
};

function readKey(env: Env, index: number): string {
  const record = env as unknown as Record<string, unknown>;
  return String(record[`GEMINI_API_KEY_${index}`] || "").trim();
}

export function getGeminiPool(env: Env, pool: GeminiPool): GeminiKeySlot[] {
  return POOL_ORDER[pool]
    .map(index => ({ index, key: readKey(env, index) }))
    .filter(slot => Boolean(slot.key));
}

export function getAllGeminiTradingSlots(env: Env): GeminiKeySlot[] {
  return [...getGeminiPool(env, "ANALYST"), ...getGeminiPool(env, "DECISION"), ...getGeminiPool(env, "FALLBACK")];
}

export function nextPoolSlot(pool: GeminiPool, slots: GeminiKeySlot[], cursor: number): { slot: GeminiKeySlot; nextCursor: number } | null {
  if (!slots.length) return null;
  const normalized = ((Math.floor(cursor) % slots.length) + slots.length) % slots.length;
  const slot = slots[normalized];
  return { slot, nextCursor: (normalized + 1) % slots.length };
}

export function poolForKey(index: number): GeminiPool | null {
  if (POOL_ORDER.ANALYST.includes(index)) return "ANALYST";
  if (POOL_ORDER.DECISION.includes(index)) return "DECISION";
  if (POOL_ORDER.FALLBACK.includes(index)) return "FALLBACK";
  return null;
}
