import {
  buyWithNative,
  publicClient,
  quoteBuy,
  quoteSell,
  sellToNative,
  tokenBalance,
  walletAddress
} from "./nadfun";

import {
  checkExecutionAllowed
} from "./execution_guard";

import {
  evaluateRisk
} from "./risk";

import {
  getTradingMode
} from "./trading_mode";

import {
  hasEmergencyExitMarker,
  upsertLivePositionMirror,
  removeLivePositionMirror
} from "./live_position_guard";

import type { Env } from "./index";


type LiveEnv = Env & {
  LIVE_TRADE_SIZE_MON?: string;
  LIVE_SLIPPAGE_BPS?: string;
  LIVE_GAS_RESERVE_MON?: string;
};


type LiveExecutionState =
  | "CREATED"
  | "RISK_CHECKED"
  | "QUOTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "REJECTED"
  | "FAILED";


const LIVE_EXECUTION_FAILURE_KEY =
  "live_execution_failure_count";

const LIVE_EXECUTION_CIRCUIT_KEY =
  "live_execution_circuit_open";

const LIVE_DEFAULT_TRADE_SIZE_MON =
  1;

const LIVE_DEFAULT_SLIPPAGE_BPS =
  500;

const LIVE_DEFAULT_GAS_RESERVE_MON =
  0.05;

const LIVE_FAILURE_THRESHOLD =
  5;


async function ensureLiveExecutionSchema(
  env: Env
): Promise<void> {

  await env.DB
    .prepare(`
      CREATE TABLE IF NOT EXISTS live_executions (
        signal_id INTEGER PRIMARY KEY,
        execution_key TEXT NOT NULL UNIQUE,
        token_address TEXT NOT NULL,
        side TEXT NOT NULL,
        state TEXT NOT NULL,
        amount_mon REAL,
        quantity TEXT,
        quote_out TEXT,
        price_usd REAL,
        tx_hash TEXT,
        error TEXT,
        created_ts_ms INTEGER NOT NULL,
        updated_ts_ms INTEGER NOT NULL
      )
    `)
    .run();

}


async function getLiveFailureCount(
  env: Env
): Promise<number> {

  return Number(
    await env.CIEL_STATE.get(
      LIVE_EXECUTION_FAILURE_KEY
    ) || "0"
  );

}


async function isLiveCircuitOpen(
  env: Env
): Promise<boolean> {

  return (
    await env.CIEL_STATE.get(
      LIVE_EXECUTION_CIRCUIT_KEY
    )
  ) === "true";

}


async function recordLiveFailure(
  env: Env,
  error: unknown
): Promise<void> {

  const previous =
    await getLiveFailureCount(env);

  const count =
    Number.isFinite(previous)
      ? previous + 1
      : 1;

  await env.CIEL_STATE.put(
    LIVE_EXECUTION_FAILURE_KEY,
    String(count)
  );

  if (
    count >=
    LIVE_FAILURE_THRESHOLD
  ) {
    await env.CIEL_STATE.put(
      LIVE_EXECUTION_CIRCUIT_KEY,
      "true"
    );
  }

  console.error(
    `Live execution failure ${count}: ${String(error).slice(0, 1000)}`
  );

}


async function recordLiveSuccess(
  env: Env
): Promise<void> {

  await env.CIEL_STATE.put(
    LIVE_EXECUTION_FAILURE_KEY,
    "0"
  );

  await env.CIEL_STATE.delete(
    LIVE_EXECUTION_CIRCUIT_KEY
  );

}


function parsePositiveNumber(
  value: unknown,
  fallback: number
): number {

  const parsed =
    Number(value);

  return (
    Number.isFinite(parsed) &&
    parsed > 0
  )
    ? parsed
    : fallback;
}


function parseSlippageBps(
  value: unknown
): number {

  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return LIVE_DEFAULT_SLIPPAGE_BPS;
  }

  return Math.min(
    9000,
    parsed
  );
}


function minimumOut(
  quote: bigint,
  slippageBps: number
): bigint {

  const numerator =
    10_000n -
    BigInt(
      Math.floor(slippageBps)
    );

  return (
    quote *
    numerator
  ) /
  10_000n;

}


async function getCurrentTokenPriceUsd(
  env: Env,
  token: string
): Promise<number> {

  const row =
    await env.DB
      .prepare(`
        SELECT price_usd
        FROM market_snapshots
        WHERE token_address=?
          AND price_usd>0
        ORDER BY ts_ms DESC
        LIMIT 1
      `)
      .bind(token)
      .first<{
        price_usd: number;
      }>();

  return Number(
    row?.price_usd || 0
  );

}


async function getMonUsd(
  env: Env
): Promise<number> {

  const stateRaw =
    await env.CIEL_STATE.get(
      "ciel_runtime_state"
    );

  if (stateRaw) {

    try {

      const state =
        JSON.parse(stateRaw) as {
          monUsd?: number;
        };

      if (
        Number(state.monUsd) > 0
      ) {
        return Number(
          state.monUsd
        );
      }

    } catch {}

  }

  return Number(
    await env.CIEL_STATE.get(
      "mon_usd"
    ) || "0"
  );

}


async function getLivePositionCount(
  env: Env
): Promise<number> {

  const row =
    await env.DB
      .prepare(`
        SELECT COUNT(*) as count
        FROM live_positions
        WHERE quantity <> '0'
      `)
      .first<{
        count: number;
      }>();

  return Number(
    row?.count || 0
  );

}


async function getLiveExposure(
  env: Env,
  monUsd: number,
  nativeBalance: bigint
): Promise<number> {

  const walletMon =
    Number(nativeBalance) /
    1e18;

  const cashUsd =
    walletMon *
    monUsd;

  const rows =
    await env.DB
      .prepare(`
        SELECT
          lp.quantity,
          s.price_usd
        FROM live_positions lp
        LEFT JOIN market_snapshots s
          ON s.token_address = lp.token_address
        WHERE lp.quantity <> '0'
          AND s.ts_ms = (
            SELECT MAX(s2.ts_ms)
            FROM market_snapshots s2
            WHERE s2.token_address =
              lp.token_address
          )
      `)
      .all<{
        quantity: string;
        price_usd: number;
      }>();

  let holdingsUsd =
    0;

  for (
    const row of rows.results || []
  ) {

    const quantity =
      Number(row.quantity);

    const price =
      Number(row.price_usd);

    if (
      quantity > 0 &&
      price > 0
    ) {
      holdingsUsd +=
        quantity *
        price;
    }

  }

  const totalUsd =
    cashUsd +
    holdingsUsd;

  if (
    totalUsd <= 0
  ) {
    return 0;
  }

  return (
    holdingsUsd /
    totalUsd
  ) *
  100;

}


async function ensureLivePositionsSchema(
  env: Env
): Promise<void> {

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

}


async function createOrReadExecution(
  env: Env,
  signal: {
    id: number;
    token_address: string;
    action: string;
  }
) {

  const executionKey =
    `live:${signal.id}`;

  const now =
    Date.now();

  await env.DB
    .prepare(`
      INSERT INTO live_executions(
        signal_id,
        execution_key,
        token_address,
        side,
        state,
        created_ts_ms,
        updated_ts_ms
      )
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(signal_id)
      DO NOTHING
    `)
    .bind(
      signal.id,
      executionKey,
      signal.token_address,
      signal.action,
      "CREATED",
      now,
      now
    )
    .run();

  const row =
    await env.DB
      .prepare(`
        SELECT *
        FROM live_executions
        WHERE signal_id=?
      `)
      .bind(signal.id)
      .first<any>();

  return {
    key: executionKey,
    row
  };

}


async function setExecutionState(
  env: Env,
  signalId: number,
  state: LiveExecutionState,
  fields: Record<string, unknown> = {}
): Promise<void> {

  const keys =
    Object.keys(fields);

  const sets = [
    "state=?",
    "updated_ts_ms=?",
    ...keys.map(
      key => `${key}=?`
    )
  ];

  const values = [
    state,
    Date.now(),
    ...keys.map(
      key => fields[key]
    )
  ];

  await env.DB
    .prepare(`
      UPDATE live_executions
      SET ${sets.join(",")}
      WHERE signal_id=?
    `)
    .bind(
      ...values,
      signalId
    )
    .run();

}


async function consumeLiveSignal(
  env: Env,
  signalId: number
): Promise<void> {

  await env.DB
    .prepare(`
      UPDATE signals
      SET consumed_ts_ms=COALESCE(consumed_ts_ms,?)
      WHERE id=?
    `)
    .bind(
      Date.now(),
      signalId
    )
    .run();

}


async function executeLiveBuy(
  env: LiveEnv,
  signal: {
    id: number;
    token_address: string;
    confidence: number;
  },
  monUsd: number
) {

  const token =
    signal.token_address as `0x${string}`;

  if (
    !/^0x[a-fA-F0-9]{40}$/.test(token)
  ) {
    throw new Error(
      "invalid token address"
    );
  }

  if (
    !env.WALLET_PRIVATE_KEY
  ) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not configured"
    );
  }

  const address =
    walletAddress(
      env.WALLET_PRIVATE_KEY
    );

  if (!address) {
    throw new Error(
      "wallet address unavailable"
    );
  }

  const client =
    publicClient(
      env.NAD_RPC_URL
    );

  const nativeBalance =
    await client.getBalance({
      address
    });

  const nativeBalanceMon =
    Number(nativeBalance) /
    1e18;

  const tradeSizeMon =
    parsePositiveNumber(
      env.LIVE_TRADE_SIZE_MON,
      LIVE_DEFAULT_TRADE_SIZE_MON
    );

  const gasReserveMon =
    parsePositiveNumber(
      env.LIVE_GAS_RESERVE_MON,
      LIVE_DEFAULT_GAS_RESERVE_MON
    );

  if (
    nativeBalanceMon <=
    tradeSizeMon +
    gasReserveMon
  ) {
    throw new Error(
      `insufficient MON balance: have ${nativeBalanceMon}, need more than ${tradeSizeMon + gasReserveMon}`
    );
  }

  const existing =
    await env.DB
      .prepare(`
        SELECT quantity
        FROM live_positions
        WHERE token_address=?
          AND quantity<>'0'
      `)
      .bind(token)
      .first<{
        quantity: string;
      }>();

  if (existing) {
    throw new Error(
      "live position already exists"
    );
  }

  const openPositions =
    await getLivePositionCount(env);

  const exposurePct =
    await getLiveExposure(
      env,
      monUsd,
      nativeBalance
    );

  const requestedPositionPct =
    (
      tradeSizeMon *
      monUsd
    ) /
    Math.max(
      (
        nativeBalanceMon *
        monUsd
      ),
      0.000001
    ) *
    100;

  const executionCheck =
    checkExecutionAllowed(
      env,
      {
        confidence:
          Number(
            signal.confidence || 0
          ),
        openPositions,
        currentExposurePct:
          exposurePct,
        requestedPositionPct
      }
    );

  if (
    !executionCheck.allowed
  ) {
    throw new Error(
      `live BUY rejected: ${executionCheck.reasons.join(", ")}`
    );
  }

  const risk =
    evaluateRisk(
      env,
      {
        confidence:
          Number(
            signal.confidence || 0
          ),
        liquidityUsd:
          Number(
            await getLiquidity(
              env,
              token
            )
          ),
        portfolioExposurePct:
          exposurePct,
        positionPct:
          requestedPositionPct
      }
    );

  if (
    !risk.allowed
  ) {
    throw new Error(
      `live BUY risk rejected: ${risk.reasons.join(", ")}`
    );
  }

  const amountIn =
    BigInt(
      Math.floor(
        tradeSizeMon *
        1e18
      )
    );

  const quote =
    await quoteBuy(
      client,
      token,
      amountIn
    );

  if (
    quote <= 0n
  ) {
    throw new Error(
      "buy quote returned zero"
    );
  }

  const slippageBps =
    parseSlippageBps(
      env.LIVE_SLIPPAGE_BPS
    );

  const amountOutMin =
    minimumOut(
      quote,
      slippageBps
    );

  await setExecutionState(
    env,
    signal.id,
    "QUOTED",
    {
      amount_mon:
        tradeSizeMon,
      quote_out:
        quote.toString()
    }
  );

  const balanceBefore =
    await tokenBalance(
      client,
      token,
      address
    );

  const txHash =
    await buyWithNative({
      rpcUrl:
        env.NAD_RPC_URL,
      privateKey:
        env.WALLET_PRIVATE_KEY,
      token,
      amountIn,
      amountOutMin
    });

  await setExecutionState(
    env,
    signal.id,
    "SUBMITTED",
    {
      tx_hash:
        txHash
    }
  );

  const receipt =
    await client.waitForTransactionReceipt({
      hash: txHash
    });

  if (
    receipt.status !== "success"
  ) {
    throw new Error(
      `BUY transaction reverted: ${txHash}`
    );
  }

  const balanceAfter =
    await tokenBalance(
      client,
      token,
      address
    );

  const tokenDelta =
    balanceAfter -
    balanceBefore;

  if (
    tokenDelta <= 0n
  ) {
    throw new Error(
      `BUY confirmed but token balance did not increase: ${txHash}`
    );
  }

  const priceUsd =
    monUsd *
    tradeSizeMon /
    (
      Number(tokenDelta) /
      1e18
    );

  const now =
    Date.now();

  await env.DB
    .prepare(`
      INSERT INTO live_positions(
        token_address,
        quantity,
        entry_price_usd,
        entry_ts_ms,
        last_price_usd,
        updated_ts_ms
      )
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(token_address)
      DO UPDATE SET
        quantity=excluded.quantity,
        entry_price_usd=excluded.entry_price_usd,
        entry_ts_ms=excluded.entry_ts_ms,
        last_price_usd=excluded.last_price_usd,
        updated_ts_ms=excluded.updated_ts_ms
    `)
    .bind(
      token,
      tokenDelta.toString(),
      priceUsd,
      now,
      priceUsd,
      now
    )
    .run();

  await env.DB
    .prepare(`
      INSERT INTO trades(
        token_address,
        ts_ms,
        side,
        quantity,
        price_usd,
        tx_hash,
        mode,
        status,
        execution_key
      )
      VALUES(?,?,?,?,?,?,?,?,?)
    `)
    .bind(
      token,
      now,
      "BUY",
      tokenDelta.toString(),
      priceUsd,
      txHash,
      "live",
      "CONFIRMED",
      `live:${signal.id}`
    )
    .run();

  await upsertLivePositionMirror(
    env,
    {
      token,
      quantity: tokenDelta.toString(),
      entryPriceUsd: priceUsd,
      entryTsMs: now
    }
  );

  await setExecutionState(
    env,
    signal.id,
    "CONFIRMED",
    {
      quantity:
        tokenDelta.toString(),
      price_usd:
        priceUsd,
      tx_hash:
        txHash
    }
  );

  await consumeLiveSignal(
    env,
    signal.id
  );

  return {
    ok: true,
    action: "BUY",
    token,
    txHash,
    quantity:
      tokenDelta.toString()
  };

}


async function executeLiveSell(
  env: LiveEnv,
  signal: {
    id: number;
    token_address: string;
    confidence: number;
  }
) {

  const token =
    signal.token_address as `0x${string}`;

  if (
    !/^0x[a-fA-F0-9]{40}$/.test(token)
  ) {
    throw new Error(
      "invalid token address"
    );
  }

  if (
    !env.WALLET_PRIVATE_KEY
  ) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not configured"
    );
  }

  const address =
    walletAddress(
      env.WALLET_PRIVATE_KEY
    );

  if (!address) {
    throw new Error(
      "wallet address unavailable"
    );
  }

  const client =
    publicClient(
      env.NAD_RPC_URL
    );

  const position =
    await env.DB
      .prepare(`
        SELECT
          quantity,
          entry_price_usd
        FROM live_positions
        WHERE token_address=?
          AND quantity<>'0'
      `)
      .bind(token)
      .first<{
        quantity: string;
        entry_price_usd: number;
      }>();

  if (
    !position
  ) {
    throw new Error(
      "no live position exists"
    );
  }

  const actualBalance =
    await tokenBalance(
      client,
      token,
      address
    );

  if (
    actualBalance <= 0n
  ) {
    await env.DB
      .prepare(`
        DELETE FROM live_positions
        WHERE token_address=?
      `)
      .bind(token)
      .run();

    await removeLivePositionMirror(
      env,
      token
    );

    throw new Error(
      "wallet has no token balance to sell"
    );
  }

  const configuredQuantity =
    BigInt(
      position.quantity
    );

  const amountIn =
    actualBalance <
      configuredQuantity
      ? actualBalance
      : configuredQuantity;

  if (
    amountIn <= 0n
  ) {
    throw new Error(
      "live sell quantity is zero"
    );
  }

  const quote =
    await quoteSell(
      client,
      token,
      amountIn
    );

  if (
    quote <= 0n
  ) {
    throw new Error(
      "sell quote returned zero"
    );
  }

  const slippageBps =
    parseSlippageBps(
      env.LIVE_SLIPPAGE_BPS
    );

  const amountOutMin =
    minimumOut(
      quote,
      slippageBps
    );

  await setExecutionState(
    env,
    signal.id,
    "QUOTED",
    {
      quantity:
        amountIn.toString(),
      quote_out:
        quote.toString()
    }
  );

  const txHash =
    await sellToNative({
      rpcUrl:
        env.NAD_RPC_URL,
      privateKey:
        env.WALLET_PRIVATE_KEY,
      token,
      amountIn,
      amountOutMin
    });

  await setExecutionState(
    env,
    signal.id,
    "SUBMITTED",
    {
      tx_hash:
        txHash
    }
  );

  const receipt =
    await client.waitForTransactionReceipt({
      hash: txHash
    });

  if (
    receipt.status !== "success"
  ) {
    throw new Error(
      `SELL transaction reverted: ${txHash}`
    );
  }

  const monUsd =
    await getMonUsd(env);

  const proceedsMon =
    Number(quote) /
    1e18;

  const exitPriceUsd =
    monUsd > 0
      ? (
          proceedsMon *
          monUsd
        ) /
        (
          Number(amountIn) /
          1e18
        )
      : 0;

  const now =
    Date.now();

  await env.DB
    .prepare(`
      INSERT INTO trades(
        token_address,
        ts_ms,
        side,
        quantity,
        price_usd,
        tx_hash,
        mode,
        status,
        execution_key
      )
      VALUES(?,?,?,?,?,?,?,?,?)
    `)
    .bind(
      token,
      now,
      "SELL",
      amountIn.toString(),
      exitPriceUsd,
      txHash,
      "live",
      "CONFIRMED",
      `live:${signal.id}`
    )
    .run();

  await env.DB
    .prepare(`
      DELETE FROM live_positions
      WHERE token_address=?
    `)
    .bind(token)
    .run();

  await removeLivePositionMirror(
    env,
    token
  );

  await setExecutionState(
    env,
    signal.id,
    "CONFIRMED",
    {
      quantity:
        amountIn.toString(),
      quote_out:
        quote.toString(),
      price_usd:
        exitPriceUsd,
      tx_hash:
        txHash
    }
  );

  await consumeLiveSignal(
    env,
    signal.id
  );

  return {
    ok: true,
    action: "SELL",
    token,
    txHash,
    quantity:
      amountIn.toString()
  };

}


async function getLiquidity(
  env: Env,
  token: string
): Promise<number> {

  const row =
    await env.DB
      .prepare(`
        SELECT liquidity_usd
        FROM tokens
        WHERE address=?
      `)
      .bind(token)
      .first<{
        liquidity_usd: number;
      }>();

  return Number(
    row?.liquidity_usd || 0
  );

}


async function executeLiveSignal(
  env: LiveEnv,
  signalId: number
) {

  if (
    getTradingMode(env) !== "live"
  ) {
    return {
      ok: false,
      skipped:
        "live trading mode is not enabled"
    };
  }

  if (
    env.TRADING_ENABLED !== "true"
  ) {
    return {
      ok: false,
      skipped:
        "TRADING_ENABLED is not true"
    };
  }

  if (
    await isLiveCircuitOpen(env)
  ) {
    return {
      ok: false,
      skipped:
        "live execution circuit breaker is open"
    };
  }

  await ensureLiveExecutionSchema(
    env
  );

  await ensureLivePositionsSchema(
    env
  );

  const signal =
    await env.DB
      .prepare(`
        SELECT
          id,
          token_address,
          action,
          confidence
        FROM signals
        WHERE id=?
      `)
      .bind(signalId)
      .first<{
        id: number;
        token_address: string;
        action: string;
        confidence: number;
      }>();

  if (
    !signal
  ) {
    return {
      ok: false,
      skipped:
        "signal missing"
    };
  }

  if (
    signal.action !== "BUY" &&
    signal.action !== "SELL"
  ) {
    return {
      ok: false,
      skipped:
        "unsupported live signal"
    };
  }

  if (
    signal.action === "SELL" &&
    await hasEmergencyExitMarker(
      env,
      signal.token_address
    )
  ) {
    await consumeLiveSignal(
      env,
      signal.id
    );
    return {
      ok: false,
      skipped:
        "position already exited by live position guard"
    };
  }

  const execution =
    await createOrReadExecution(
      env,
      signal
    );

  if (
    execution.row?.state ===
    "CONFIRMED"
  ) {
    return {
      ok: true,
      skipped:
        "live signal already executed",
      txHash:
        execution.row.tx_hash
    };
  }

  if (
    execution.row?.state ===
    "SUBMITTED"
  ) {
    return {
      ok: false,
      skipped:
        "live signal already submitted; awaiting confirmation"
    };
  }

  if (
    execution.row?.state ===
    "REJECTED"
  ) {
    return {
      ok: false,
      skipped:
        execution.row.error ||
        "live signal previously rejected"
    };
  }

  const monUsd =
    await getMonUsd(env);

  if (
    !(monUsd > 0)
  ) {
    throw new Error(
      "MON/USD price is unavailable"
    );
  }

  await setExecutionState(
    env,
    signal.id,
    "RISK_CHECKED"
  );

  if (
    signal.action === "BUY"
  ) {

    try {

      const result =
        await executeLiveBuy(
          env,
          signal,
          monUsd
        );

      await recordLiveSuccess(
        env
      );

      return result;

    } catch (error) {

      await setExecutionState(
        env,
        signal.id,
        "FAILED",
        {
          error:
            String(error).slice(
              0,
              1000
            )
        }
      );

      await recordLiveFailure(
        env,
        error
      );

      await consumeLiveSignal(
        env,
        signal.id
      );

      return {
        ok: false,
        error:
          String(error).slice(
            0,
            1000
          )
      };

    }

  }

  try {

    const result =
      await executeLiveSell(
        env,
        signal
      );

    await recordLiveSuccess(
      env
    );

    return result;

  } catch (error) {

    await setExecutionState(
      env,
      signal.id,
      "FAILED",
      {
        error:
          String(error).slice(
            0,
            1000
          )
      }
    );

    await recordLiveFailure(
      env,
      error
    );

    await consumeLiveSignal(
      env,
      signal.id
    );

    return {
      ok: false,
      error:
        String(error).slice(
          0,
          1000
        )
    };

  }

}


export async function runLiveSignalCycle(
  env: LiveEnv
): Promise<void> {

  if (
    env.TRADING_ENABLED !== "true"
  ) {
    return;
  }

  if (
    await isLiveCircuitOpen(env)
  ) {
    console.warn(
      "Live execution circuit breaker is open"
    );

    return;
  }

  await ensureLiveExecutionSchema(
    env
  );

  await ensureLivePositionsSchema(
    env
  );

  const cutoff =
    Date.now() -
    15 * 60 * 1000;

  const rows =
    await env.DB
      .prepare(`
        SELECT
          id
        FROM signals
        WHERE action IN ('BUY','SELL')
          AND consumed_ts_ms IS NULL
          AND ts_ms>=?
        ORDER BY ts_ms ASC
        LIMIT 10
      `)
      .bind(cutoff)
      .all<{
        id: number;
      }>();

  for (
    const row of rows.results || []
  ) {

    try {

      await executeLiveSignal(
        env,
        row.id
      );

    } catch (error) {

      console.error(
        `Live signal ${row.id} failed: ${String(error).slice(0, 1000)}`
      );

    }

  }

}
