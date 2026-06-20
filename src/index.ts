import { Hono } from 'hono';
import { ChatRoomDO } from './do/chat-room-do';
import { messagesRoutes } from './routes/messages';
import { wsRoutes } from './routes/ws';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';

export { ChatRoomDO };

export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Auth: HS256 JWT signing secret. In dev this comes from [vars] in
  // wrangler.toml; in prod it MUST be a Workers Secret.
  JWT_SECRET: string;
}

// Variables attached to the Hono context by middleware (e.g. auth -> user).
type AppVariables = { user: string };

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

app.route('/api/auth', authRoutes);
app.route('/api/messages', messagesRoutes);
app.route('/api/billing', billingRoutes);
app.route('/rooms', wsRoutes);

// Fallback: serve static assets (frontend) for non-API paths
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
