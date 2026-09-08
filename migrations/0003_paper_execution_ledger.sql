CREATE TABLE IF NOT EXISTS paper_executions (
  signal_id INTEGER PRIMARY KEY,
  execution_key TEXT NOT NULL UNIQUE,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  state TEXT NOT NULL,
  balance_before_mon REAL,
  balance_after_mon REAL,
  quantity TEXT,
  quote_out TEXT,
  fill_price_usd REAL,
  realized_pnl_usd REAL,
  position_quantity_after TEXT,
  error TEXT,
  created_ts_ms INTEGER NOT NULL,
  updated_ts_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_executions_state ON paper_executions(state, updated_ts_ms);

ALTER TABLE trades ADD COLUMN execution_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL;
