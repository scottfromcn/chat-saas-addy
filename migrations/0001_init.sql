-- Migration: 0001_init
-- MVP messages table for chat-saas.
-- Per SPEC: id, room, user, text, created_at.
-- Added a cursor-friendly ordered id (autoincrement INTEGER PRIMARY KEY) and
-- a TEXT id column for stable client references; both returned by the API.

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_created
  ON messages(room, created_at DESC);
