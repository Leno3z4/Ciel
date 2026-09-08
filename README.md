# Ciel

NAD.FUN / Monad market-monitoring and adaptive trading engine.

## Safety defaults

Ciel starts in paper-trading mode and with real execution disabled. Keep secrets out of source control. Use Cloudflare Worker secrets for Gemini keys, the Telegram credentials, and a dedicated burner-wallet private key when live execution is eventually enabled.

```bash
wrangler secret put GEMINI_API_KEY_1
wrangler secret put GEMINI_API_KEY_2
wrangler secret put WALLET_PRIVATE_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

Do not use a seed phrase. A dedicated private key limits blast radius if the bot is compromised.

## Loops

- every 2 minutes: inspect held positions and apply deterministic emergency/risk rules
- every 5 minutes: collect and normalize market activity
- hourly: update statistical baselines and send meaningful regime deviations to Gemini
- Telegram: send operational, signal, trade, and error notifications through the existing InfoTrader bot

## Architecture

Cloudflare Worker + Cron Triggers, D1 for queryable market/trade state, R2 for high-volume historical event storage, KV for lightweight state, and a Durable Object for serialized trading coordination.

Gemini is an analysis layer, not the sole source of truth for execution. Every live order must pass deterministic liquidity, slippage, exposure, cooldown, and emergency-loss checks.

## Next adapter step

Pin the current NAD.FUN/Monad APIs and contract interfaces from their documentation, then implement the market-data and swap adapters. Do not guess contract addresses or endpoints.
