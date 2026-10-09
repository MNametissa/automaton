export const PAYMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  payer TEXT NOT NULL,
  recipient TEXT NOT NULL,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  reserved_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','submitted','uncertain','confirmed','released')),
  nonce TEXT,
  tx_hash TEXT,
  fulfilled INTEGER NOT NULL DEFAULT 0,
  purchase_id TEXT NOT NULL DEFAULT '',
  request_fingerprint TEXT NOT NULL,
  response_json TEXT,
  response_status INTEGER,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_operation ON payment_attempts(operation_key, status);
`;

export const PAYMENT_RECOVERY_MIGRATION = `
ALTER TABLE payment_attempts ADD COLUMN scan_start_block TEXT;
ALTER TABLE payment_attempts ADD COLUMN scan_next_block TEXT;
`;
