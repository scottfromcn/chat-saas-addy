// Auth routes: POST /api/auth/register and /api/auth/login.
//
// Both return { token, user: { email } } on success.
// - register: hash password (PBKDF2), INSERT; on UNIQUE conflict -> 409.
// - login:    look up by email, verify hash; on miss/bad-pw -> 401 (same body
//   so we don't leak which one failed).

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../index';
import { hashPassword, verifyPassword } from '../lib/password';
import { signJwt } from '../lib/jwt';
import { ensureFreeSubscription } from './billing';

export const authRoutes = new Hono<{ Bindings: Env }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AuthBody = z.object({
  email: z.string().max(254).regex(EMAIL_RE, 'invalid_email'),
  password: z.string().min(8, 'password_too_short').max(200),
});

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
}

async function issueToken(env: { JWT_SECRET: string }, email: string) {
  return signJwt({ sub: email }, env.JWT_SECRET);
}

authRoutes.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'INVALID_JSON' }, 400);
  }
  const parsed = AuthBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, 400);
  }
  const { email, password } = parsed.data;

  const passwordHash = await hashPassword(password);
  const now = Date.now();
  // INSERT ... RETURNING so we don't need a second SELECT.
  // On UNIQUE(email) conflict D1 raises SQLITE_CONSTRAINT_UNIQUE which we
  // detect by the error message rather than a typed exception.
  let userRow: { id: number; email: string; created_at: number };
  try {
    const row = await c.env.DB.prepare(
      'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, email, created_at',
    ).bind(email, passwordHash, now).first<{ id: number; email: string; created_at: number }>();
    if (!row) {
      // RETURNING should always produce a row for a successful INSERT.
      return c.json({ error: 'REGISTER_FAILED' }, 500);
    }
    userRow = row;
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
      return c.json({ error: 'EMAIL_TAKEN' }, 409);
    }
    throw e;
  }

  // Round 4: provision a free subscription row so the paywall has a row to
  // read. INSERT OR IGNORE makes it safe if the row somehow already exists.
  await ensureFreeSubscription(c.env, userRow.id);

  const token = await issueToken(c.env, email);
  return c.json({ token, user: { email } }, 201);
});

authRoutes.post('/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'INVALID_JSON' }, 400);
  }
  const parsed = AuthBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, 400);
  }
  const { email, password } = parsed.data;

  const row = await c.env.DB.prepare(
    'SELECT id, email, password_hash, created_at FROM users WHERE email = ?',
  ).bind(email).first<UserRow>();

  // Same response for "no such user" and "wrong password" to avoid user
  // enumeration.
  const GENERIC = { error: 'INVALID_CREDENTIALS' };
  if (!row) return c.json(GENERIC, 401);

  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) return c.json(GENERIC, 401);

  const token = await issueToken(c.env, row.email);
  return c.json({ token, user: { email: row.email } });
});
