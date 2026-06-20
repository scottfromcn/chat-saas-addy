-- Migration: 0003_subscriptions
-- Billing/paywall mock slice (round 4). Adds per-user subscription state.
--
-- Design notes:
-- - Separate table rather than adding columns to users, to keep the auth
--   slice (0002) untouched and the schema change purely additive.
-- - user_id is a FK to users(id) ON DELETE CASCADE so subscription dies with
--   the user. We do NOT migrate the historical messages rows (they still
--   carry TEXT emails from round 2); the paywall quota query joins on email.
-- - status is TEXT with a CHECK to keep it to free|paid; we don't use an
--   enum because SQLite's enum support is weak. Adding 'trialing' later
--   is a one-line CHECK change.
-- - current_period_end is in ms-since-epoch to match the rest of the codebase
--   (messages.created_at, users.created_at). Free rows store 0 / NULL.
-- - plan is TEXT ('pro' in this mock) — keeping room for tier names later.
--
-- Paywall MVP:
--   On user register (0002), the auth route will INSERT a row here with
--   status='free'. The messages POST path will count today's messages by
--   the authenticated email and 402 (PAYMENT_REQUIRED) past the free quota.
--   Mock checkout + webhook flip status to 'paid'.

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('free', 'paid')),
  plan TEXT,
  current_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
