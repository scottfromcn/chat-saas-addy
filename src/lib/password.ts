// Password hashing using Web Crypto PBKDF2-SHA256.
//
// Format stored in DB: "<salt_b64>.<hash_b64>"
// - salt: 16 random bytes, base64
// - hash: PBKDF2-SHA256, 100_000 iterations, 32 bytes output, base64
//
// Why PBKDF2 and not scrypt: Web Crypto in Workers only ships PBKDF2
// natively (no scrypt/bcrypt). Pulling in a pure-JS scrypt would violate
// "simplest thing that works"; PBKDF2 with a sane iteration count is the
// standard Cloudflare-recommended pattern for Workers.

const ITERATIONS = 100_000;
const KEY_LEN = 32; // SHA-256 = 32 bytes
const SALT_LEN = 16;

const enc = new TextEncoder();

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Copy a Uint8Array into a fresh ArrayBuffer-backed view so SubtleCrypto's
// strict BufferSource typing (which rejects ArrayBufferLike) is satisfied.
function toAB(u: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u.byteLength);
  new Uint8Array(buf).set(u);
  return buf;
}

async function deriveBits(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toAB(enc.encode(password)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toAB(salt), iterations: ITERATIONS },
    baseKey,
    KEY_LEN * 8,
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await deriveBits(password, salt);
  return `${b64encode(salt)}.${b64encode(new Uint8Array(hash))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const dot = stored.indexOf('.');
  if (dot === -1) return false;
  const salt = b64decode(stored.slice(0, dot));
  const expected = b64decode(stored.slice(dot + 1));
  const actual = new Uint8Array(await deriveBits(password, salt));
  if (actual.length !== expected.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}
