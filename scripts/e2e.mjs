// End-to-end verification simulating two browser sessions.
//
// Covers the user-visible flow:
//   1. Browser fetches HTML from / (assets binding works)
//   2. JS bundle loads
//   3. Client loads message history via GET /api/messages
//   4. Client opens WebSocket to /rooms/:room/ws
//   5. Two clients exchange messages in real time
//   6. Reload confirms messages persisted to D1
//
// Run: node scripts/e2e.mjs   (after `wrangler dev --port 8787` is up)

import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:8787';
const ROOM = 'e2e-room';
const OUT = '/tmp/e2e.out';
const lines = [];
const log = (s) => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 1. HTML served.
const html = await (await fetch(`${BASE}/`)).text();
if (!html.includes('id="root"') || !html.includes('/assets/')) {
  throw new Error('frontend HTML not served');
}
log('[1/6] GET / -> HTML with root div + asset script');

// 2. JS bundle loads.
const asset = html.match(/\/assets\/[^"]+\.js/)[0];
const jsStatus = (await fetch(`${BASE}${asset}`)).status;
if (jsStatus !== 200) throw new Error(`asset not served: ${jsStatus}`);
log(`[2/6] GET ${asset} -> 200`);

// 3. Seed history via HTTP POST (simulating first user posting via composer).
const seed = await (
  await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: ROOM, user: 'carol', text: 'seed via http' }),
  })
).json();
log(`[3/6] POST /api/messages -> id=${seed.id} text="${seed.text}"`);

const history = await (await fetch(`${BASE}/api/messages?room=${ROOM}`)).json();
if (!history.items.some((m) => m.text === 'seed via http')) {
  throw new Error('history did not include seeded message');
}
log(`[3/6] GET /api/messages -> ${history.items.length} message(s) in room`);

// 4-5. Two WebSocket clients exchange messages.
function connect(tag) {
  const ws = new WebSocket(`ws://localhost:8787/rooms/${ROOM}/ws`);
  ws.tag = tag;
  return ws;
}
function waitOpen(ws) {
  return new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
}
function nextMsg(ws, ms = 5000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ws.tag)), ms);
    ws.addEventListener(
      'message',
      (e) => {
        clearTimeout(t);
        res(JSON.parse(e.data));
      },
      { once: true },
    );
  });
}

const dave = connect('dave');
const eve = connect('eve');
await waitOpen(dave);
await waitOpen(eve);
log('[4/6] dave + eve connected over WebSocket');

dave.send(JSON.stringify({ type: 'send', user: 'dave', text: 'hi from dave' }));
const daveEcho = await nextMsg(dave);
const eveRecv = await nextMsg(eve);
log(`[5/6] dave -> eve broadcast verified: "${eveRecv.message.text}"`);
if (eveRecv.message.text !== 'hi from dave') throw new Error('broadcast lost');

eve.send(JSON.stringify({ type: 'send', user: 'eve', text: 'hi from eve' }));
const eveEcho = await nextMsg(eve);
const daveRecv = await nextMsg(dave);
log(`[5/6] eve -> dave broadcast verified: "${daveRecv.message.text}"`);
if (daveRecv.message.text !== 'hi from eve') throw new Error('reverse broadcast lost');

// 6. Reload confirms persistence.
const after = await (await fetch(`${BASE}/api/messages?room=${ROOM}`)).json();
const texts = after.items.map((m) => m.text);
if (!texts.includes('hi from dave') || !texts.includes('hi from eve')) {
  throw new Error('ws messages not persisted');
}
log(`[6/6] reload GET /api/messages -> ${after.items.length} messages, all ws posts present`);

dave.close();
eve.close();
await wait(100);

log('\nALL CHECKS PASSED.');
writeFileSync(OUT, lines.join('\n') + '\n');
process.exit(0);
