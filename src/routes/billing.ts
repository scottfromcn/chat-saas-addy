// Billing routes: mock Stripe checkout + webhook.
//
// Round 4 paywall slice. We deliberately do NOT integrate real Stripe:
//   - POST /api/billing/checkout   → returns a stub { session_id, url }
//   - POST /api/billing/confirm    → front-end hits the fake url, which calls
//                                    the webhook logic to flip the user to paid
//   - POST /api/billing/webhook    → marks the session's user as paid
//
// Mock signature "verification":
//   The webhook checks that `session_id` matches one we minted and that the
//   session's email matches a real user. There is no HMAC against a Stripe
//   signing secret — the dev harness can call webhook directly with just the
//   session_id. We surface this clearly in the response so it can never be
//   confused with a real Stripe integration.
//
// All three routes need the user's email to look up the subscription. For
// /checkout and the GET status we use the Bearer token (requireAuth). For
// /webhook and /confirm we resolve via the session_id (so they're callable
// without a token, matching how Stripe really works).

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';

export const billingRoutes = new Hono<{ Bindings: Env; Variables: { user: string } }>();

// Free-tier daily quota. Past this the POST /api/messages path returns 402.
export const FREE_DAILY_QUOTA = 50;

// In-process checkout session registry. A real Stripe persists this server-side
// and the client only knows the url + session_id. We mirror that shape: store
// just enough (email + window) to let /confirm and /webhook resolve the user
// from the session_id alone. Lost on Worker restart — acceptable for a mock.
const sessions = new Map<string, { email: string; createdAt: number }>();

function mintSessionId(email: string): string {
  // Cheap unique-ish id; not a security boundary (mock only).
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  const emailHash = email.split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7);
  return `cs_test_${ts}${emailHash.toString(36).replace('-', '')}${rand}`;
}

interface SubRow {
  user_id: number;
  status: 'free' | 'paid';
  plan: string | null;
  current_period_end: number;
  updated_at: number;
}

// GET /api/billing/status — what tier am I on, how many msgs left today?
billingRoutes.get('/status', requireAuth, async (c) => {
  const email = c.get('user');
  const sub = await getSubscription(c.env, email);
  const usedToday = await countMessagesToday(c.env, email);
  return c.json({
    status: sub?.status ?? 'free',
    plan: sub?.plan ?? null,
    currentPeriodEnd: sub?.current_period_end ?? 0,
    quota: {
      limit: sub?.status === 'paid' ? null : FREE_DAILY_QUOTA,
      used: usedToday,
      remaining: sub?.status === 'paid' ? null : Math.max(0, FREE_DAILY_QUOTA - usedToday),
    },
  });
});

// POST /api/billing/checkout — mint a fake session. Returns a url that points
// at our own /confirm endpoint so the front-end can finish the flow without
// leaving the page.
const CheckoutBody = z.object({
  plan: z.enum(['pro']).default('pro'),
});

billingRoutes.post('/checkout', requireAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json().catch(() => ({}));
  } catch {
    body = {};
  }
  const parsed = CheckoutBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, 400);
  }
  const email = c.get('user');
  const sessionId = mintSessionId(email);
  sessions.set(sessionId, { email, createdAt: Date.now() });

  const url = new URL(c.req.url);
  const origin = `${url.protocol}//${url.host}`;
  const fakeUrl = `${origin}/api/billing/confirm?session_id=${encodeURIComponent(sessionId)}`;

  return c.json({
    sessionId,
    // Stripe-shaped field name (`url`) so swapping in real Stripe later is
    // a drop-in change. Comment in the report.
    url: fakeUrl,
    provider: 'mock',
    note: 'No real payment is processed. The mock url completes via /confirm.',
  }, 201);
});

// POST /api/billing/confirm — front-end fetches the fake url returned by
// /checkout. We treat it as "user completed checkout" and run the webhook
// logic. The session_id is taken from the query string (the fake url embeds
// it there). Body form is intentionally not supported to keep the mock simple.
billingRoutes.post('/confirm', async (c) => {
  const sessionId = c.req.query('session_id');
  const result = await fulfillSession(c.env, sessionId);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({ ok: true, status: 'paid', email: result.email });
});

// GET form too, so the fake url is clickable in a browser for manual sanity.
billingRoutes.get('/confirm', async (c) => {
  const sessionId = c.req.query('session_id');
  const result = await fulfillSession(c.env, sessionId);
  if (!result.ok) {
    return new Response(
      `<html><body><h1>mock checkout failed</h1><pre>${result.error}</pre></body></html>`,
      { status: result.status, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
  return new Response(
    `<html><body><h1>mock checkout ok</h1>` +
      `<p>${result.email} is now <b>paid</b>. You can close this tab.</p></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
});

// POST /api/billing/webhook — would be called by Stripe in production.
// Here we accept it from anywhere (dev harness / the /confirm route). The
// "verification" is: session_id must exist in our in-memory registry and
// map to a real user. No HMAC, no signing-secret check.
const WebhookBody = z.object({
  sessionId: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  email: z.string().email().optional(),
}).refine(
  (v) => v.sessionId || v.session_id || v.email,
  { message: 'must provide sessionId or email' },
);

billingRoutes.post('/webhook', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'INVALID_JSON' }, 400);
  }
  const parsed = WebhookBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'INVALID_BODY', issues: parsed.error.issues }, 400);
  }
  const { sessionId, session_id, email } = parsed.data;
  const sid = sessionId ?? session_id;

  // Mock "signature": session_id registered by /checkout wins; otherwise
  // fall back to email (lets the dev harness flip a user directly).
  let targetEmail = email;
  if (sid) {
    const reg = sessions.get(sid);
    if (reg) {
      targetEmail = reg.email;
      sessions.delete(sid); // one-shot
    } else if (!targetEmail) {
      // Unknown session_id and no email → reject, like a forged webhook.
      return c.json({ error: 'UNKNOWN_SESSION' }, 400);
    }
  }
  if (!targetEmail) {
    return c.json({ error: 'UNKNOWN_SESSION' }, 400);
  }

  const flipped = await markPaid(c.env, targetEmail, 'pro');
  if (!flipped) {
    return c.json({ error: 'USER_NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, status: 'paid', email: targetEmail, provider: 'mock' });
});

// ---------- shared helpers (also used by messages.ts paywall check) ----------

export async function getSubscription(
  env: Env,
  email: string,
): Promise<SubRow | null> {
  return env.DB.prepare(
    `SELECT s.user_id, s.status, s.plan, s.current_period_end, s.updated_at
       FROM subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE u.email = ?`,
  ).bind(email).first<SubRow>();
}

// Today's message count for the given user email. Day boundary is local
// server time (Date() — Workers run UTC). Good enough for a daily quota.
export async function countMessagesToday(env: Env, email: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.getTime();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE user = ? AND created_at >= ?',
  ).bind(email, since).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function ensureFreeSubscription(env: Env, userId: number): Promise<void> {
  // INSERT OR IGNORE so calling it on every register is idempotent.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions (user_id, status, plan, current_period_end, updated_at)
     VALUES (?, 'free', NULL, 0, ?)`,
  ).bind(userId, Date.now()).run();
}

async function markPaid(env: Env, email: string, plan: string): Promise<boolean> {
  const now = Date.now();
  // 30 days from now, matching a real monthly subscription period end.
  const periodEnd = now + 30 * 24 * 60 * 60 * 1000;
  const res = await env.DB.prepare(
    `UPDATE subscriptions
        SET status = 'paid', plan = ?, current_period_end = ?, updated_at = ?
      WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
  ).bind(plan, periodEnd, now, email).run();
  return (res.meta?.changes ?? 0) > 0;
}

async function fulfillSession(
  env: Env,
  sessionId: string | undefined,
): Promise<{ ok: true; email: string } | { ok: false; error: string; status: 400 | 404 }> {
  if (!sessionId) return { ok: false, error: 'MISSING_SESSION_ID', status: 400 };
  const reg = sessions.get(sessionId);
  if (!reg) return { ok: false, error: 'UNKNOWN_SESSION', status: 400 };
  sessions.delete(sessionId);
  const flipped = await markPaid(env, reg.email, 'pro');
  if (!flipped) return { ok: false, error: 'USER_NOT_FOUND', status: 404 };
  return { ok: true, email: reg.email };
}
