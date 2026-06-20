import { Hono } from 'hono';
import type { Env } from '../index';

export const wsRoutes = new Hono<{ Bindings: Env }>();

// GET /rooms/:room/ws — upgrade to a WebSocket handled by the ChatRoomDO
// whose Durable Object id is derived from the room name.
wsRoutes.get('/:room/ws', (c) => {
  const room = c.req.param('room');
  if (!room) {
    return c.json({ error: 'ROOM_REQUIRED' }, 400);
  }
  const id = c.env.CHAT_ROOM.idFromName(room);
  const stub = c.env.CHAT_ROOM.get(id);
  // Pass the upgrade request straight through to the DO. The DO returns a 101
  // with the server-side socket already wired up.
  return stub.fetch(c.req.raw);
});
