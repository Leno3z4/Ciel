import type { Env } from "./index";
import { upsertLivePositionMirror, removeLivePositionMirror, type LivePositionMirror } from "./live_position_guard";

const MAX_POSITIONS = 10;

export async function syncLivePositionMirror(env: Env): Promise<void> {
  if (env.TRADING_ENABLED !== "true" || env.PAPER_TRADING === "true") return;

  const rows = await env.DB.prepare(`
    SELECT
      token_address as token,
      quantity,
      entry_price_usd as entryPriceUsd,
      entry_ts_ms as entryTsMs,
      last_price_usd as lastPriceUsd,
      updated_ts_ms as updatedTsMs
    FROM live_positions
    WHERE quantity <> '0'
    ORDER BY updated_ts_ms DESC
    LIMIT ?
  `).bind(MAX_POSITIONS).all<{
    token: string;
    quantity: string;
    entryPriceUsd: number;
    entryTsMs: number;
    lastPriceUsd: number;
    updatedTsMs: number;
  }>();

  const live = (rows.results || []).filter(row => /^0x[a-fA-F0-9]{40}$/.test(row.token));
  const liveKeys = new Set(live.map(row => row.token.toLowerCase()));

  for (const row of live) {
    await upsertLivePositionMirror(env, {
      token: row.token,
      quantity: row.quantity,
      entryPriceUsd: Number(row.entryPriceUsd || 0),
      entryTsMs: Number(row.entryTsMs || 0)
    });
  }

  const hotRaw = await env.CIEL_STATE.get("ciel_live_positions_hot");
  if (!hotRaw) return;

  let hot: LivePositionMirror[] = [];
  try {
    const parsed = JSON.parse(hotRaw) as unknown;
    if (Array.isArray(parsed)) hot = parsed as LivePositionMirror[];
  } catch {
    return;
  }

  for (const position of hot) {
    if (!liveKeys.has(position.token.toLowerCase())) {
      await removeLivePositionMirror(env, position.token);
    }
  }
}
