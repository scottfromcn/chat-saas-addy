// Minimal HS256 JWT implementation over Web Crypto.
//
// We deliberately don't pull in a JWT library — for an auth MVP we only need
// to sign and verify a `{ sub, iat, exp }` payload with HS256, which is ~70
// lines using SubtleCrypto.
//
// Token claims:
//   sub: user email (used as the `user` field on messages)
//   iat: issued-at (seconds)
//   exp: expiry (seconds); 7d default
//
// The HMAC key comes from env.JWT_SECRET. In dev that's a fixed var set in
// wrangler.toml; in prod it MUST be a Workers Secret.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function toAB(u: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u.byteLength);
  new Uint8Array(buf).set(u);
  return buf;
}

async function hmacKey(secret: string, usage: CryptoKey['usages']): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toAB(enc.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage,
  );
}

export interface JwtClaims {
  sub: string;
  iat: number;
  exp: number;
}

export async function signJwt(
  claims: Omit<JwtClaims, 'iat' | 'exp'> & { exp?: number },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = {
    sub: claims.sub,
    iat: now,
    exp: claims.exp ?? now + 7 * 24 * 3600,
  };
  const header = b64url(new Uint8Array(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))));
  const body = b64url(new Uint8Array(enc.encode(JSON.stringify(payload))));
  const data = `${header}.${body}`;
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, toAB(enc.encode(data)));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const data = `${header}.${body}`;
  const key = await hmacKey(secret, ['verify']);
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify('HMAC', key, toAB(b64urlDecode(sig)), toAB(enc.encode(data)));
  } catch {
    return null;
  }
  if (!ok) return null;
  let claims: JwtClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || Math.floor(Date.now() / 1000) >= claims.exp) {
    return null;
  }
  return claims;
}
