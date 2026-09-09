export type IntelligenceReport = {
  symbol: string;
  marketCap: number;
  phase: string;
  momentum: number;
  liquidityHealth: string;
  buyPressure: number;
  bestWindow?: string;
  decision?: string;
  confidence?: number;
};

function money(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
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
    "",
    "Signals:",
    `📈 Momentum: ${report.momentum}/100`,
    `💧 Liquidity: ${report.liquidityHealth}`,
    `🔥 Buy Pressure: ${Math.round(report.buyPressure * 100)}%`,
    report.bestWindow ? `⏰ Best Window: ${report.bestWindow}` : "",
    "",
    report.decision ? `Gemini: ${report.decision}` : "",
    report.confidence !== undefined ? `Confidence: ${Math.round(report.confidence * 100)}%` : ""
  ].filter(Boolean).join("\n");
}
