// Auth middleware: parses the Bearer token, verifies the JWT, and puts the
// authenticated user's email on `c.set('user', email)`. Returns 401 on any
// failure. Used by /api/messages (and any future authenticated route).
//
// We deliberately do NOT touch the WebSocket upgrade path here — adding auth
// to /rooms/:room/ws is out of scope for this slice (it'd require either a
// query-string token or a subprotocol header, which is a separate concern).
// See report.

import { Context, Next } from 'hono';
import { verifyJwt } from '../lib/jwt';

export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  if (!token) {
    return c.json({ error: 'UNAUTHORIZED', reason: 'missing_bearer' }, 401);
  }
  const secret: string | undefined = c.env.JWT_SECRET;
  if (!secret) {
    // Misconfig — JWT_SECRET must be set in wrangler vars/secrets.
    return c.json({ error: 'SERVER_MISCONFIG', reason: 'no_jwt_secret' }, 500);
  }
  const claims = await verifyJwt(token, secret);
  if (!claims || !claims.sub) {
    return c.json({ error: 'UNAUTHORIZED', reason: 'invalid_token' }, 401);
  }
  c.set('user', claims.sub);
  await next();
}
