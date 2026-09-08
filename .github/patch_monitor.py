from pathlib import Path
import re
import subprocess

p = Path('src/index.ts')
s = p.read_text()

s = s.replace(
    'lastModelAnalyzed?: number;\n  monUsd?: number;',
    'lastModelAnalyzed?: number;\n  lastModelError?: string;\n  lastMarketCycleError?: string;\n  monUsd?: number;',
    1,
)

s, n = re.subn(
    r'async function runHoldingCheck\(env: Env\) \{.*?\n\}\n\nasync function runPaperPositionMonitoring',
    '''async function runHoldingCheck(env: Env) {
  const checkedAt = Date.now();
  try {
    await ensureDatabaseSchema(env);
    const state = await readRuntimeState(env);
    const monUsd = Number(state.monUsd || await env.CIEL_STATE.get("mon_usd"));
    if (!(monUsd > 0)) {
      await writeRuntimeState(env, { lastHoldingCheck: checkedAt });
      return;
    }
    if (env.PAPER_TRADING === "true" && env.TRADING_ENABLED !== "true") await runPaperPositionMonitoring(env, monUsd);
    const address = walletAddress(env.WALLET_PRIVATE_KEY);
    if (!address) {
      await writeRuntimeState(env, { lastHoldingCheck: checkedAt });
      return;
    }
    const native = await publicClient(env.NAD_RPC_URL).getBalance({ address });
    if (native === 0n) {
      await writeRuntimeState(env, { lastHoldingCheck: checkedAt });
      return;
    }
    const tokens = await env.DB.prepare("SELECT address,decimals FROM tokens WHERE graduated=1").all<{ address: string; decimals: number }>();
    for (const row of tokens.results || []) {
      const balance = await tokenBalance(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, address);
      if (balance > 0n) {
        const quote = await quoteSell(publicClient(env.NAD_RPC_URL), row.address as `0x${string}`, balance);
        if (quote > 0n) {
          const valueUsd = Number(quote) / 1e18 * monUsd;
          if (valueUsd > 0) await writeRuntimeState(env, { lastHoldingCheck: checkedAt, paperUnrealizedPnlUsd: undefined });
        }
      }
    }
    await writeRuntimeState(env, { lastHoldingCheck: checkedAt });
  } catch (error) {
    await writeRuntimeState(env, { lastHoldingCheck: checkedAt });
    console.error(`Holding check failed: ${String(error).slice(0, 1000)}`);
  }
}

async function runPaperPositionMonitoring''',
    s,
    flags=re.S,
)
if n != 1: raise SystemExit(f'holding replacement count={n}')

s, n = re.subn(
    r'async function runMarketCycle\(env: Env\) \{.*?\n\}\n\nasync function runPaperSignalCycle',
    '''async function runMarketCycle(env: Env) {
  const cycleAt = Date.now();
  try {
    await ensureDatabaseSchema(env);
    const result = await indexNadFun(env);
    await writeRuntimeState(env, { lastMarketCycle: cycleAt, lastMarketCycleError: undefined });
    if (result && result.snapshots > 0) await notifyTelegram(env, `📡 Ciel indexer\\nSnapshots: ${result.snapshots}`);
    await runPaperSignalCycle(env);
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await writeRuntimeState(env, { lastMarketCycle: cycleAt, lastMarketCycleError: message });
    console.error(`Market cycle failed: ${message}`);
  }
}

async function runPaperSignalCycle''',
    s,
    flags=re.S,
)
if n != 1: raise SystemExit(f'market replacement count={n}')

s, n = re.subn(
    r'async function runModelMaintenance\(env: Env\) \{.*?\n\}\n\nasync function status',
    '''async function runModelMaintenance(env: Env) {
  const maintenanceAt = Date.now();
  try {
    await ensureDatabaseSchema(env);
    const result = await env.DB.prepare("SELECT * FROM signals ORDER BY ts_ms DESC LIMIT 50").all();
    const rows = (result.results || []) as unknown as Snapshot[];
    const baseline = buildBaseline(rows);
    const last = rows[0];
    if (last) deviationScore(last, baseline);
    await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: undefined });
    const analysis = await askGemini(env, rows);
    if (analysis) {
      await writeRuntimeState(env, { lastModelAnalyzed: Date.now() });
      await notifyTelegram(env, `🧠 Ciel model\\n${analysis.slice(0, 3000)}`);
    }
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: message });
    console.error(`Model maintenance failed: ${message}`);
  }
}

async function status''',
    s,
    flags=re.S,
)
if n != 1: raise SystemExit(f'model replacement count={n}')

s, n = re.subn(
    r'async function status\(env: Env\) \{.*?\n\}\n\nfunction json',
    '''async function status(env: Env) {
  const indexerRaw = await env.CIEL_STATE.get("indexer_state");
  let indexerState: { lastRunMs?: number } = {};
  try { if (indexerRaw) indexerState = JSON.parse(indexerRaw); } catch {}
  const telegramRaw = await env.CIEL_STATE.get("ciel_telegram_runtime");
  let telegramState: { lastAttemptAt?: number; lastSuccessAt?: number; lastFailureAt?: number; lastError?: string; lastTestAt?: number; lastTestSuccess?: boolean } = {};
  try { if (telegramRaw) telegramState = JSON.parse(telegramRaw); } catch {}
  const state = await readRuntimeState(env);
  return {
    tradingEnabled: env.TRADING_ENABLED === "true",
    paperTrading: env.PAPER_TRADING === "true",
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    telegramLastAttemptAt: telegramState.lastAttemptAt || null,
    telegramLastSuccessAt: telegramState.lastSuccessAt || null,
    telegramLastFailureAt: telegramState.lastFailureAt || null,
    telegramLastError: telegramState.lastError || null,
    telegramLastTestAt: telegramState.lastTestAt || null,
    telegramLastTestSuccess: telegramState.lastTestSuccess ?? null,
    paperBalanceMon: await getPaperBalance(env),
    paperRealizedPnlUsd: Number(await env.CIEL_STATE.get(PAPER_REALIZED_PNL_KEY) || "0"),
    paperFailureCount: Number(await env.CIEL_STATE.get(PAPER_FAILURE_COUNT_KEY) || "0"),
    paperCircuitOpen: await env.CIEL_STATE.get(PAPER_CIRCUIT_KEY) === "true",
    lastHoldingCheck: state.lastHoldingCheck || null,
    lastMarketCycle: state.lastMarketCycle || indexerState.lastRunMs || null,
    lastMarketCycleError: state.lastMarketCycleError || null,
    lastModelMaintenance: state.lastModelMaintenance || null,
    lastModelAnalyzed: state.lastModelAnalyzed || null,
    lastModelError: state.lastModelError || null
  };
}

function json''',
    s,
    flags=re.S,
)
if n != 1: raise SystemExit(f'status replacement count={n}')

p.write_text(s)

for path in ['.github/patch_monitor.py', '.github/workflows/one-time-telegram-monitor-patch.yml', '.telegram-monitor-patch-trigger', '.telegram-monitor-patch-trigger-2', '.telegram-monitor-patch-trigger-3', '.telegram-monitor-patch-error.txt']:
    target = Path(path)
    if target.exists(): target.unlink()

subprocess.run(['git', 'config', 'user.name', 'github-actions[bot]'], check=True)
subprocess.run(['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], check=True)
subprocess.run(['git', 'add', 'src/index.ts', '-A'], check=True)
subprocess.run(['git', 'commit', '-m', 'fix: add runtime monitoring and scheduler diagnostics'], check=True)
subprocess.run(['git', 'push', 'origin', 'main'], check=True)
