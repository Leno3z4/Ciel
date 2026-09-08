ALTER TABLE tokens ADD COLUMN total_supply TEXT;
ALTER TABLE tokens ADD COLUMN decimals INTEGER NOT NULL DEFAULT 18;
ALTER TABLE tokens ADD COLUMN quote_token TEXT;
ALTER TABLE tokens ADD COLUMN pair_address TEXT;
ALTER TABLE tokens ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN created_at_block INTEGER;

CREATE INDEX IF NOT EXISTS idx_tokens_market_cap ON tokens(market_cap_usd DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_liquidity ON tokens(liquidity_usd DESC);
CREATE INDEX IF NOT EXISTS idx_signals_token_ts ON signals(token_address, ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trades_token_ts ON trades(token_address, ts_ms DESC);

ALTER TABLE market_snapshots ADD COLUMN quote_token TEXT;
ALTER TABLE market_snapshots ADD COLUMN buy_volume_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE market_snapshots ADD COLUMN sell_volume_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE market_snapshots ADD COLUMN source_block INTEGER;
