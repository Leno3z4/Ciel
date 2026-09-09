type StatusInput = {
  markets?: number;
  tracked?: number;
  geminiHealthy?: boolean;
  paperBalance?: number;
  openPositions?: number;
  pnl?: number;
};

function usd(value: number | undefined): string {
  if (!Number.isFinite(Number(value))) return "$0";
  return `$${Number(value).toFixed(2)}`;
}

export function buildStatusReport(input: StatusInput): string {
  return [
    "🧠 Ciel Status",
    "",
    `Markets: ${input.markets ?? 0}`,
    `Tracked: ${input.tracked ?? 0}`,
    `Gemini: ${input.geminiHealthy === false ? "⚠️ degraded" : "✅ healthy"}`,
    `Paper Balance: ${usd(input.paperBalance)}`,
    `Open Positions: ${input.openPositions ?? 0}`,
    `Today's PnL: ${usd(input.pnl)}`
  ].join("\n");
}
