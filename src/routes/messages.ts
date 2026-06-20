import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';
import { FREE_DAILY_QUOTA, getSubscription, countMessagesToday } from './billing';

// Authenticated message routes.
//
// Round 2 had `user` as a client-supplied body field (anonymous nicknames).
// Round 3 replaces that with the authenticated user's email from the JWT
// (set by requireAuth onto c.var.user). The body now only carries {room, text}.
//
// The `messages.user` column is reused as-is — we store the email string
// rather than adding a user_id FK, to keep this slice a pure additive change
// (see report for rationale).

export const messagesRoutes = new Hono<{ Bindings: Env; Variables: { user: string } }>();

const MAX_TEXT = 2000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const ListQuery = z.object({
  room: z.string().min(1).max(100),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const CreateBody = z.object({
  room: z.string().min(1).max(100),
  text: z.string().min(1).max(MAX_TEXT),
});

interface MessageRow {
  id: number;
  room: string;
  user: string;
  text: string;
  created_at: number;
}

function toClient(r: MessageRow) {
  return {
    id: r.id,
    room: r.room,
    user: r.user,
    text: r.text,
    createdAt: r.created_at,
  };
}

// Both GET (history) and POST (create) require a valid bearer token.
messagesRoutes.use('*', requireAuth);

messagesRoutes.get('/', async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'INVALID_QUERY', issues: parsed.error.issues }, 400);
  }
  const { room, before, limit } = parsed.data;

  const rows = before
    ? await c.env.DB.prepare(
      'SELECT id, room, user, text, created_at FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?',
    ).bind(room, before, limit).all<MessageRow>()
    : await c.env.DB.prepare(
      'SELECT id, room, user, text, created_at FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?',
    ).bind(room, limit).all<MessageRow>();

  const items = rows.results ?? [];
  const nextCursor = items.length === limit ? items[items.length - 1]?.id ?? null : null;
  return c.json({
    items: items.reverse().map(toClient),
    nextCursor,
  });
});

messagesRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'INVALID_JSON' }, 400);
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, 400);
  }
  const { room, text } = parsed.data;
  // Authenticated user comes from the JWT, not the body.
  const user = c.get('user');

  // Round 4 paywall: free users are capped at FREE_DAILY_QUOTA messages per
  // day. Paid users are unlimited. The quota counts messages persisted to D1
  // by this user email since local-midnight. We check here (not in a
  // middleware) because the limit is resource-specific to message creation
  // and doesn't apply to GET (history) or other endpoints.
  const sub = await getSubscription(c.env, user);
  const status = sub?.status ?? 'free';
  if (status !== 'paid') {
    const usedToday = await countMessagesToday(c.env, user);
    if (usedToday >= FREE_DAILY_QUOTA) {
      return c.json(
        {
          error: 'QUOTA_EXCEEDED',
          reason: 'free_daily_quota',
          quota: { limit: FREE_DAILY_QUOTA, used: usedToday, remaining: 0 },
          // Front-end uses this to render the upgrade CTA.
          upgrade: { checkoutPath: '/api/billing/checkout', provider: 'mock' },
        },
        402,
      );
    }
  }

  const now = Date.now();
  const result = await c.env.DB.prepare(
    'INSERT INTO messages (room, user, text, created_at) VALUES (?, ?, ?, ?) RETURNING id, room, user, text, created_at',
  ).bind(room, user, text, now).first<MessageRow>();

  if (!result) {
    return c.json({ error: 'INSERT_FAILED' }, 500);
  }

  const doId = c.env.CHAT_ROOM.idFromName(room);
  const stub = c.env.CHAT_ROOM.get(doId);
  c.executionCtx.waitUntil(
    stub.fetch('http://internal/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toClient(result)),
    }).catch(() => undefined),
  );

  return c.json(toClient(result), 201);
});
