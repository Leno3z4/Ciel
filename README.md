# Ciel

Ciel is a NAD.FUN V2 / Monad market-monitoring and adaptive trading engine.

## Current state

- Main branch contains the active implementation.
- Live trading is disabled by default: `TRADING_ENABLED=false` and `PAPER_TRADING=true`.
- NadFun V2 Router is used for lifecycle-aware quotes and execution.
- Market activity is indexed into D1/R2 from the official NadFun V2 bonding-curve events.
- Statistical baselines are token-specific; Gemini is used for higher-level market/regime analysis, not as the sole execution authority.
- Held positions are checked every 2 minutes for deterministic emergency exits.

## Cloudflare resources

Create these resources before deployment:

```bash
npx wrangler kv namespace create CIEL_STATE
npx wrangler d1 create ciel
npx wrangler r2 bucket create ciel-market-data
```

Put the returned KV namespace ID and D1 database ID into `wrangler.jsonc`. Do not invent or reuse IDs from another project.

Apply D1 migrations remotely:

```bash
npx wrangler d1 migrations apply ciel --remote
```

## Secrets

Sensitive values must be Worker secrets, not `vars` or source code. Cloudflare validates names declared in `secrets.required` during deployment.

```bash
npx wrangler secret put GEMINI_API_KEY_1
npx wrangler secret put GEMINI_API_KEY_2
npx wrangler secret put WALLET_PRIVATE_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Use a dedicated burner wallet private key only. Never put a seed phrase/private key into GitHub, source files, or chat.

## Development

```bash
npm install
npm run typecheck
npm run dev
```

The repository also runs the TypeScript check through GitHub Actions on pushes to `main`.

## Runtime loops

- Every 2 minutes: held-position balances, current router quotes, deterministic emergency-loss checks.
- Every 5 minutes: NadFun event indexing and normalized market snapshots.
- Every hour: baseline refresh, anomaly detection, and dual Gemini analysis for the highest-cap/liquid tokens with meaningful deviations.

## Trading safety

A live transaction requires all of the following:

1. `TRADING_ENABLED=true`.
2. `PAPER_TRADING=false`.
3. A configured burner-wallet private key.
4. Deterministic risk gates must pass.
5. Router quote/slippage bounds must be available immediately before execution.

Adding a wallet secret alone does not enable live trading.
