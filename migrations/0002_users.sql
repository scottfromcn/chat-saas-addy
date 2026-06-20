-- Migration: 0002_users
-- Auth slice (round 3). Adds the users table for email+password auth.
--
-- Design notes:
-- - password_hash stores "<salt_b64>.<hash_b64>" produced by PBKDF2-SHA256
--   in src/lib/password.ts. We never store the plaintext password.
-- - email is UNIQUE so register/login can rely on a single row per email;
--   we catch the constraint violation in the route to return 409.
-- - messages table from 0001 stays untouched. We keep its `user` TEXT column
--   (now interpreted as the email/subject of the authenticated user) rather
--   than adding a user_id FK, to keep the slice minimal — see report for
--   rationale.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
