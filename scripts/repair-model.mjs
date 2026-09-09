import { readFileSync, writeFileSync } from "node:fs";

const path = "src/index.ts";
const text = readFileSync(path, "utf8");
const start = text.indexOf("async function runModelMaintenance(env: Env) {");
const end = text.indexOf("\n\nasync function status(env: Env) {", start);
if (start < 0 || end < 0) throw new Error("runModelMaintenance block not found");

const replacement = `async function runModelMaintenance(env: Env) {
  const maintenanceAt = Date.now();
  try {
    await ensureDatabaseSchema(env);

    const latest = await env.DB.prepare(\`SELECT token_address as token,ts_ms as tsMs,price_usd as priceUsd,market_cap_usd as marketCapUsd,liquidity_usd as liquidityUsd,volume_5m_usd as volume5mUsd,buys_5m as buys5m,sells_5m as sells5m,holders\n      FROM market_snapshots WHERE price_usd>0 ORDER BY ts_ms DESC LIMIT 1\`).first<Snapshot>();
    if (!latest) {
      await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: undefined });
      return;
    }

    const historyResult = await env.DB.prepare(\`SELECT token_address as token,ts_ms as tsMs,price_usd as priceUsd,market_cap_usd as marketCapUsd,liquidity_usd as liquidityUsd,volume_5m_usd as volume5mUsd,buys_5m as buys5m,sells_5m as sells5m,holders\n      FROM market_snapshots WHERE token_address=? AND price_usd>0 ORDER BY ts_ms DESC LIMIT 50\`).bind(latest.token).all<Snapshot>();
    const history = historyResult.results || [];
    const current = history[0] || latest;
    const baseline = buildBaseline(history);
    const score = deviationScore(current, baseline);
    await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: undefined });

    const apiKey = env.GEMINI_API_KEY_1 || env.GEMINI_API_KEY_2;
    const analysis = await askGemini(apiKey, env.GEMINI_MODEL, "market", current, baseline, score);
    if (!analysis) return;

    await writeRuntimeState(env, { lastModelAnalyzed: Date.now() });
    const expectedLow = Number.isFinite(analysis.expectedLowUsd) ? analysis.expectedLowUsd.toFixed(8) : "n/a";
    const expectedHigh = Number.isFinite(analysis.expectedHighUsd) ? analysis.expectedHighUsd.toFixed(8) : "n/a";
    const confidencePct = (analysis.confidence * 100).toFixed(1);
    const anomalyPct = (analysis.anomalyScore * 100).toFixed(1);
    const message = \`🧠 Ciel model\\nToken: \${current.token}\\nAction: \${analysis.action}\\nConfidence: \${confidencePct}%\\nAnomaly: \${anomalyPct}%\\nRegime: \${analysis.regime}\\nExpected: $\${expectedLow} - $\${expectedHigh}\\nRationale: \${analysis.rationale}\`;
    await notifyTelegram(env, message.slice(0, 3900));
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await writeRuntimeState(env, { lastModelMaintenance: maintenanceAt, lastModelError: message });
    console.error(\`Model maintenance failed: \${message}\`);
  }
}`;

if (text.slice(start, end) !== replacement) writeFileSync(path, text.slice(0, start) + replacement + text.slice(end));
