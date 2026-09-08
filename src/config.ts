export const config = {
  // Never commit secrets. Set these with `wrangler secret put`.
  secrets: [
    "GEMINI_API_KEY_1",
    "GEMINI_API_KEY_2",
    "WALLET_PRIVATE_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID"
  ],
  risk: {
    maxPositionPct: 5,
    maxPortfolioExposurePct: 25,
    maxSlippageBps: 500,
    emergencyDropPct: 15,
    minimumLiquidityUsd: 10000,
    minimumSignalConfidence: 0.72
  },
  monitoring: {
    holdingsMinutes: 2,
    marketMinutes: 5,
    modelMinutes: 60
  }
} as const;
