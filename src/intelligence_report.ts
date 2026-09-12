export type IntelligenceReport = {
  symbol: string;
  marketCap: number;
  phase: string;
  lifecyclePhase?: string;
  trendStructure?: string;
  waveCount?: number;
  currentWave?: number;
  momentum: number;
  liquidityHealth: string;
  buyPressure: number;
  breakoutQuality?: number;
  retracementQuality?: number;
  blowOffRisk?: number;
  distributionRisk?: number;
  deathRisk?: number;
  bestWindow?: string;
  decision?: string;
  confidence?: number;
};

function money(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function formatIntelligenceReport(report: IntelligenceReport): string {
  return [
    "🧠 Ciel Intelligence Report",
    "",
    `🔥 ${report.symbol}`,
    "",
    `Market Cap: ${money(report.marketCap)}`,
    "",
    `Phase: ${report.phase}`,
    report.lifecyclePhase ? `Lifecycle: ${report.lifecyclePhase}` : "",
    report.trendStructure ? `Structure: ${report.trendStructure}` : "",
    report.waveCount !== undefined ? `Wave: ${report.currentWave ?? 1}/${report.waveCount}` : "",
    "",
    "Signals:",
    `📈 Momentum: ${report.momentum}/100`,
    `💧 Liquidity: ${report.liquidityHealth}`,
    `🔥 Buy Pressure: ${Math.round(report.buyPressure * 100)}%`,
    report.breakoutQuality !== undefined ? `🚀 Breakout Quality: ${percent(report.breakoutQuality)}` : "",
    report.retracementQuality !== undefined ? `↩️ Retracement Quality: ${percent(report.retracementQuality)}` : "",
    report.blowOffRisk !== undefined ? `⚠️ Blow-off Risk: ${percent(report.blowOffRisk)}` : "",
    report.distributionRisk !== undefined ? `📉 Distribution Risk: ${percent(report.distributionRisk)}` : "",
    report.deathRisk !== undefined ? `💀 Death Risk: ${percent(report.deathRisk)}` : "",
    report.bestWindow ? `⏰ Best Window: ${report.bestWindow}` : "",
    "",
    report.decision ? `Gemini: ${report.decision}` : "",
    report.confidence !== undefined ? `Confidence: ${Math.round(report.confidence * 100)}%` : ""
  ].filter(Boolean).join("\n");
}
