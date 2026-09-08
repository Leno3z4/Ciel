import type { Env } from "./index";

export type PaperSide = "BUY" | "SELL";

export interface PaperOrder {
  token: string;
  side: PaperSide;
  quantity: string;
  priceUsd: number;
  quoteUsd: number;
  signalId?: number;
  reason: string;
}

export async function executePaperOrder(env: Env, order: PaperOrder): Promise<void> {
  if (!Number.isFinite(order.priceUsd) || order.priceUsd <= 0) throw new Error("paper order price must be positive");
  if (!Number.isFinite(order.quoteUsd) || order.quoteUsd <= 0) throw new Error("paper order value must be positive");
  if (!order.token.startsWith("0x")) throw new Error("invalid token address");

  const now = Date.now();
  const existing = await env.DB.prepare("SELECT quantity, entry_price_usd FROM positions WHERE token_address=?").bind(order.token).first<{ quantity: string; entry_price_usd: number }>();
  const oldQty = Number(existing?.quantity ?? 0);
  const requestedQty = Number(order.quantity);
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) throw new Error("paper order quantity must be positive");

  if (order.side === "BUY") {
    const oldCost = oldQty * Number(existing?.entry_price_usd ?? order.priceUsd);
    const newQty = oldQty + requestedQty;
    const average = (oldCost + order.quoteUsd) / newQty;
    await env.DB.prepare("INSERT INTO positions(token_address,quantity,entry_price_usd,entry_ts_ms,last_price_usd,updated_ts_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(token_address) DO UPDATE SET quantity=excluded.quantity,entry_price_usd=excluded.entry_price_usd,last_price_usd=excluded.last_price_usd,updated_ts_ms=excluded.updated_ts_ms").bind(order.token, String(newQty), average, existing ? undefined : now, order.priceUsd, now).run();
  } else {
    const newQty = Math.max(0, oldQty - requestedQty);
    if (newQty === 0) await env.DB.prepare("DELETE FROM positions WHERE token_address=?").bind(order.token).run();
    else await env.DB.prepare("UPDATE positions SET quantity=?,last_price_usd=?,updated_ts_ms=? WHERE token_address=?").bind(String(newQty), order.priceUsd, now, order.token).run();
  }

  await env.DB.prepare("INSERT INTO trades(token_address,ts_ms,side,quantity,price_usd,tx_hash,mode,status,error) VALUES(?,?,?,?,?,?,?,?,?)").bind(order.token, now, order.side, order.quantity, order.priceUsd, null, "paper", "filled", null).run();
}

export function paperOrderAllowed(env: Env): boolean {
  return env.PAPER_TRADING === "true" && env.TRADING_ENABLED !== "true";
}
