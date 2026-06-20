// Minimal end-to-end WebSocket test for two clients in the same room.
//
// Usage: node scripts/ws-test.mjs
//
// What it verifies:
//   1. Both clients can connect to /rooms/<room>/ws.
//   2. When alice sends a `send` frame, bob receives the broadcast.
//   3. The sender (alice) gets its own echo.
//   4. After the WS round-trip, the message is also in D1 history (HTTP GET).

import { writeFileSync } from 'node:fs';

const ROOM = 'ws-test-room';
const URL = `ws://localhost:8787/rooms/${ROOM}/ws`;
const OUT = '/tmp/ws-test.out';
const lines = [];
const log = (s) => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

function connect(name) {
  const ws = new WebSocket(URL);
  ws.tag = name;
  return ws;
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting on ${ws.tag}`)), timeoutMs);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data));
      },
      { once: true },
    );
    ws.addEventListener('close', () => reject(new Error('socket closed early')), { once: true });
  });
}

const alice = connect('alice');
const bob = connect('bob');

await waitForOpen(alice);
await waitForOpen(bob);
log(`[connect] alice open, bob open -> room=${ROOM}`);

const sent = { type: 'send', user: 'alice', text: 'hello bob via ws' };
alice.send(JSON.stringify(sent));
log('[send]   alice -> ' + JSON.stringify(sent));

const aliceEcho = await nextMessage(alice);
const bobRecv = await nextMessage(bob);

log('[echo]   alice got: ' + JSON.stringify(aliceEcho));
log('[recv]   bob   got: ' + JSON.stringify(bobRecv));

if (aliceEcho.type !== 'message' || aliceEcho.message.text !== 'hello bob via ws') {
  throw new Error('alice echo mismatch');
}
if (bobRecv.type !== 'message' || bobRecv.message.text !== 'hello bob via ws') {
  throw new Error('bob did not receive broadcast');
}

const reply = { type: 'send', user: 'bob', text: 'hi alice' };
bob.send(JSON.stringify(reply));
log('[send]   bob   -> ' + JSON.stringify(reply));

const bobEcho = await nextMessage(bob);
const aliceRecv = await nextMessage(alice);
log('[echo]   bob   got: ' + JSON.stringify(bobEcho));
log('[recv]   alice got: ' + JSON.stringify(aliceRecv));

if (aliceRecv.message.text !== 'hi alice') throw new Error('alice did not receive bob broadcast');

const res = await fetch(`http://localhost:8787/api/messages?room=${ROOM}`);
const body = await res.json();
const texts = body.items.map((m) => m.text);
log('[persist] HTTP history: ' + JSON.stringify(texts));
if (!texts.includes('hello bob via ws') || !texts.includes('hi alice')) {
  throw new Error('WS messages not persisted to D1');
}

alice.close();
bob.close();
log('\nOK: WS round-trip + persistence verified.');
writeFileSync(OUT, lines.join('\n') + '\n');
process.exit(0);
