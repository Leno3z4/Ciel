CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  market_cap_usd REAL,
  liquidity_usd REAL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  price_usd REAL,
  market_cap_usd REAL,
  liquidity_usd REAL,
  volume_5m_usd REAL,
  buys_5m INTEGER,
  sells_5m INTEGER,
  holders INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snapshots_token_ts ON market_snapshots(token_address, ts_ms);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  confidence REAL,
  expected_low REAL,
  expected_high REAL,
  anomaly_score REAL,
  model TEXT,
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  side TEXT NOT NULL,
  quantity TEXT,
  price_usd REAL,
  tx_hash TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  token_address TEXT PRIMARY KEY,
  quantity TEXT NOT NULL,
  entry_price_usd REAL,
  entry_ts_ms INTEGER,
  last_price_usd REAL,
  updated_ts_ms INTEGER NOT NULL
);
