ALTER TABLE tokens ADD COLUMN total_supply TEXT;
ALTER TABLE tokens ADD COLUMN decimals INTEGER NOT NULL DEFAULT 18;
ALTER TABLE tokens ADD COLUMN quote_token TEXT;
ALTER TABLE tokens ADD COLUMN pair_address TEXT;
ALTER TABLE tokens ADD COLUMN graduated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN created_at_block INTEGER;

ALTER TABLE market_snapshots ADD COLUMN quote_token TEXT;
ALTER TABLE market_snapshots ADD COLUMN buy_volume_usd REAL;
ALTER TABLE market_snapshots ADD COLUMN sell_volume_usd REAL;
ALTER TABLE market_snapshots ADD COLUMN source_block INTEGER;

ALTER TABLE signals ADD COLUMN consumed_ts_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms);
