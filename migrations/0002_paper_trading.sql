ALTER TABLE signals ADD COLUMN consumed_ts_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms);
