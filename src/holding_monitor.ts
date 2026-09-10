import {
  publicClient,
  quoteSell,
  tokenBalance,
  walletAddress
} from "./nadfun";

import { notifyTelegram } from "./telegram";

import type { Env } from "./index";

const HOLDING_TELEMETRY_KEY =
  "ciel_holding_telemetry_last_run_ms";

const HOLDING_TELEMETRY_INTERVAL_MS =
  10 * 60 * 1000;

const PAPER_RUNTIME_KEY =
  "ciel_runtime_state";

function positiveQuantitySql(
  column: string
): string {
  return `${column} <> '0'`;
}

async function readRuntime(
  env: Env
): Promise<Record<string, unknown>> {
  const raw =
    await env.CIEL_STATE.get(
      PAPER_RUNTIME_KEY
    );

  if (!raw) return {};

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeRuntime(
  env: Env,
  patch: Record<string, unknown>
): Promise<void> {
  const current =
    await readRuntime(env);

  await env.CIEL_STATE.put(
    PAPER_RUNTIME_KEY,
    JSON.stringify({
      ...current,
      ...patch
    })
  );
}

async function getMonUsd(
  env: Env
): Promise<number> {
  const runtime =
    await readRuntime(env);

  const runtimePrice =
    Number(runtime.monUsd || 0);

  if (runtimePrice > 0) {
    return runtimePrice;
  }

  return Number(
    await env.CIEL_STATE.get(
      "mon_usd"
    ) || "0"
  );
}

async function monitorPaperPositions(
  env: Env
): Promise<number> {
  const monUsd =
    await getMonUsd(env);

  const rows =
    await env.DB
      .prepare(`
        SELECT
          p.token_address,
          p.quantity,
          p.entry_price_usd,
          s.price_usd
        FROM positions p
        LEFT JOIN market_snapshots s
          ON s.token_address = p.token_address
        WHERE ${positiveQuantitySql("p.quantity")}
          AND s.ts_ms = (
            SELECT MAX(s2.ts_ms)
            FROM market_snapshots s2
            WHERE s2.token_address = p.token_address
          )
      `)
      .all<{
        token_address: string;
        quantity: string;
        entry_price_usd: number;
        price_usd: number;
      }>();

  let totalUnrealized = 0;

  for (
    const row of rows.results || []
  ) {
    const quantity =
      Number(row.quantity || 0);

    const entry =
      Number(
        row.entry_price_usd || 0
      );

    const price =
      Number(row.price_usd || 0);

    if (
      quantity <= 0 ||
      price <= 0
    ) {
      continue;
    }

    totalUnrealized +=
      (price - entry) *
      quantity;

    const changePct =
      entry > 0
        ? ((price - entry) / entry) * 100
        : 0;

    if (
      changePct <= -15
    ) {
      await notifyTelegram(
        env,
        `🚨 Ciel PAPER emergency exit candidate\nToken: ${row.token_address}\nMove: ${changePct.toFixed(2)}%\nAction: review/sell signal`
      );
    }
  }

  await writeRuntime(
    env,
    {
      lastHoldingCheck:
        Date.now(),
      paperUnrealizedPnlUsd:
        totalUnrealized,
      monUsd
    }
  );

  return rows.results?.length || 0;
}

async function monitorLivePositions(
  env: Env
): Promise<number> {
  if (
    env.TRADING_ENABLED !== "true"
  ) {
    return 0;
  }

  if (
    !env.WALLET_PRIVATE_KEY
  ) {
    return 0;
  }

  await env.DB
    .prepare(`
      CREATE TABLE IF NOT EXISTS live_positions (
        token_address TEXT PRIMARY KEY,
        quantity TEXT NOT NULL,
        entry_price_usd REAL,
        entry_ts_ms INTEGER,
        last_price_usd REAL,
        updated_ts_ms INTEGER NOT NULL
      )
    `)
    .run();

  const address =
    walletAddress(
      env.WALLET_PRIVATE_KEY
    );

  if (!address) {
    return 0;
  }

  const rows =
    await env.DB
      .prepare(`
        SELECT
          token_address,
          quantity,
          entry_price_usd
        FROM live_positions
        WHERE quantity <> '0'
      `)
      .all<{
        token_address: string;
        quantity: string;
        entry_price_usd: number;
      }>();

  if (!(rows.results?.length)) {
    return 0;
  }

  const client =
    publicClient(
      env.NAD_RPC_URL
    );

  let checked = 0;

  for (
    const row of rows.results
  ) {
    const token =
      row.token_address as `0x${string}`;

    if (
      !/^0x[a-fA-F0-9]{40}$/.test(token)
    ) {
      continue;
    }

    const balance =
      await tokenBalance(
        client,
        token,
        address
      );

    if (
      balance <= 0n
    ) {
      continue;
    }

    const quote =
      await quoteSell(
        client,
        token,
        balance
      );

    if (
      quote <= 0n
    ) {
      continue;
    }

    checked += 1;
  }

  return checked;
}

export async function runOptimizedHoldingCheck(
  env: Env
): Promise<void> {
  const now =
    Date.now();

  const last = Number(
    await env.CIEL_STATE.get(
      HOLDING_TELEMETRY_KEY
    ) || "0"
  );

  if (
    last > 0 &&
    now - last <
      HOLDING_TELEMETRY_INTERVAL_MS
  ) {
    return;
  }

  await env.CIEL_STATE.put(
    HOLDING_TELEMETRY_KEY,
    String(now),
    { expirationTtl: 3600 }
  );

  try {
    let paperPositions = 0;
    let livePositions = 0;

    if (
      env.PAPER_TRADING === "true"
    ) {
      paperPositions =
        await monitorPaperPositions(env);
    }

    if (
      env.TRADING_ENABLED === "true"
    ) {
      livePositions =
        await monitorLivePositions(env);
    }

    await writeRuntime(
      env,
      {
        lastHoldingCheck: now,
        lastHoldingPaperPositions:
          paperPositions,
        lastHoldingLivePositions:
          livePositions
      }
    );
  } catch (error) {
    await writeRuntime(
      env,
      {
        lastHoldingCheck: now,
        lastHoldingCheckError:
          String(error).slice(0, 1000)
      }
    );

    console.error(
      `Optimized holding check failed: ${String(error).slice(0, 1000)}`
    );
  }
}
