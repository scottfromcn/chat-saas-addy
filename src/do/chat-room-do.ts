// ChatRoomDO — one Durable Object per chat room.
//
// Two responsibilities:
//   1. WebSocket hub: each room DO holds a Set of open sockets; on a new
//      connection we register it; on an inbound `send` frame we broadcast
//      to every other connection in the room and persist the message to D1.
//   2. HTTP broadcast endpoint: the Worker POSTs here when a message was
//      created over HTTP, so WebSocket clients see it too.
//
// We keep the implementation deliberately simple (Rule 0 of
// incremental-implementation: simplest thing that works). No batching, no
// alarms, no rate limiting in this slice — those are later rounds.

interface ClientMessage {
  type: 'send';
  user: string;
  text: string;
}

export interface BroadcastPayload {
  type: 'message';
  message: {
    id: number | string;
    room: string;
    user: string;
    text: string;
    createdAt: number;
  };
}

export class ChatRoomDO implements DurableObject {
  private sockets = new Set<WebSocket>();

  constructor(
    private state: DurableObjectState,
    private env: { DB: D1Database },
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // WebSocket upgrade: /ws (path doesn't matter — DO is per-room already).
    if (req.headers.get('upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSocket(server as WebSocket);
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP broadcast from Worker (message originated over HTTP API).
    if (req.method === 'POST' && url.pathname === '/broadcast') {
      let payload: BroadcastPayload;
      try {
        payload = (await req.json()) as BroadcastPayload;
      } catch {
        return new Response('bad json', { status: 400 });
      }
      this.broadcast(payload);
      return new Response('ok', { status: 200 });
    }

    return new Response('not found', { status: 404 });
  }

  private handleSocket(ws: WebSocket): void {
    ws.accept();
    this.sockets.add(ws);

    ws.addEventListener('message', async (event) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(event.data as string) as ClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'INVALID_JSON' }));
        return;
      }
      if (msg.type !== 'send' || typeof msg.user !== 'string' || typeof msg.text !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'INVALID_MESSAGE' }));
        return;
      }
      if (msg.text.length === 0 || msg.text.length > 2000) {
        ws.send(JSON.stringify({ type: 'error', error: 'INVALID_TEXT_LENGTH' }));
        return;
      }

      // Persist then broadcast. Room name comes from the DO id() — we stored it
      // at construction time via idFromName, so we read it back here.
      const room = this.state.id.name ?? 'unknown';
      const now = Date.now();
      const result = await this.env.DB.prepare(
        'INSERT INTO messages (room, user, text, created_at) VALUES (?, ?, ?, ?) RETURNING id, room, user, text, created_at',
      )
        .bind(room, msg.user, msg.text, now)
        .first<{ id: number; room: string; user: string; text: string; created_at: number }>();

      if (!result) {
        ws.send(JSON.stringify({ type: 'error', error: 'INSERT_FAILED' }));
        return;
      }

      const payload: BroadcastPayload = {
        type: 'message',
        message: {
          id: result.id,
          room: result.room,
          user: result.user,
          text: result.text,
          createdAt: result.created_at,
        },
      };
      // Echo to sender so it can confirm, plus broadcast to everyone else.
      ws.send(JSON.stringify(payload));
      this.broadcast(payload, ws);
    });

    ws.addEventListener('close', () => {
      this.sockets.delete(ws);
    });

    ws.addEventListener('error', () => {
      this.sockets.delete(ws);
    });
  }

  private broadcast(payload: BroadcastPayload, exclude?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.sockets) {
      if (ws === exclude) continue;
      // send() can throw if the socket is in CLOSING/CLOSED; swallow.
      try {
        ws.send(data);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}
