import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Message {
  id: number;
  room: string;
  user: string;
  text: string;
  createdAt: number;
}

interface AuthState {
  token: string;
  email: string;
}

interface BillingState {
  status: 'free' | 'paid';
  plan: string | null;
  currentPeriodEnd: number;
  quota: {
    limit: number | null;
    used: number;
    remaining: number | null;
  };
}

const TOKEN_KEY = 'chat.token';
const EMAIL_KEY = 'chat.email';

function wsUrl(room: string, token: string): string {
  const loc = window.location;
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // Auth over WS upgrade is out of scope for this slice (see report).
  // We pass the token as a query param purely so the connection URL changes
  // when the user logs in/out, forcing a clean reconnect. The server does
  // NOT currently read it.
  return `${scheme}//${loc.host}/rooms/${encodeURIComponent(room)}/ws?t=${encodeURIComponent(token)}`;
}

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    const email = localStorage.getItem(EMAIL_KEY);
    if (token && email) return { token, email };
    return null;
  });

  if (!auth) {
    return <AuthForm onAuthed={setAuth} />;
  }
  return (
    <Chat
      auth={auth}
      onLogout={() => {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(EMAIL_KEY);
        setAuth(null);
      }}
    />
  );
}

function AuthForm({ onAuthed }: { onAuthed: (a: AuthState) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await r.json()) as { error?: string; token?: string; user?: { email?: string } };
      if (!r.ok) {
        setError(data?.error ?? `HTTP ${r.status}`);
        return;
      }
      if (!data.token || !data.user?.email) {
        setError('malformed response');
        return;
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(EMAIL_KEY, data.user.email);
      onAuthed({ token: data.token, email: data.user.email });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>chat-saas · {mode}</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['register', 'login'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              padding: '6px',
              cursor: 'pointer',
              background: mode === m ? '#111' : '#eee',
              color: mode === m ? '#fff' : '#000',
              border: 'none',
              borderRadius: 4,
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ padding: 8 }}
        />
        <input
          type="password"
          placeholder="password (min 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          style={{ padding: 8 }}
        />
        {error && <div style={{ color: '#900', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          {busy ? '...' : mode}
        </button>
      </form>
    </div>
  );
}

// Run the full mock upgrade flow:
//   POST /checkout → { url }  (url points at /api/billing/confirm?session_id=…)
//   POST <url>               → flips user to paid
// Returns the JSON from /confirm, or throws.
async function runMockUpgrade(token: string): Promise<{ ok: boolean; status: string; email?: string }> {
  const co = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'pro' }),
  });
  if (!co.ok) {
    const err = (await co.json().catch(() => ({}))) as { error?: string };
    throw new Error(`checkout ${co.status}: ${err.error ?? ''}`);
  }
  const { url } = (await co.json()) as { url: string };

  // Hit the fake "Stripe return URL", which is our own /confirm endpoint.
  const cf = await fetch(url, { method: 'POST' });
  return (await cf.json()) as { ok: boolean; status: string; email?: string };
}

function Chat({ auth, onLogout }: { auth: AuthState; onLogout: () => void }) {
  const [room, setRoom] = useState('general');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('closed');
  const [error, setError] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refreshBilling = useCallback(async () => {
    try {
      const r = await fetch('/api/billing/status', {
        headers: { authorization: `Bearer ${auth.token}` },
      });
      if (r.ok) setBilling((await r.json()) as BillingState);
    } catch {
      /* non-fatal */
    }
  }, [auth.token]);

  useEffect(() => {
    refreshBilling();
  }, [refreshBilling]);

  useEffect(() => {
    setError(null);
    let cancelled = false;

    fetch(`/api/messages?room=${encodeURIComponent(room)}`, {
      headers: { authorization: `Bearer ${auth.token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`history HTTP ${r.status}`);
        return (await r.json()) as { items: Message[] };
      })
      .then((data) => {
        if (!cancelled) setMessages(data.items);
      })
      .catch((e) => setError(String(e)));

    const ws = new WebSocket(wsUrl(room, auth.token));
    wsRef.current = ws;
    setStatus('connecting');

    ws.addEventListener('open', () => setStatus('open'));
    ws.addEventListener('close', () => setStatus('closed'));
    ws.addEventListener('error', () => setError('ws error'));
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'message') {
        setMessages((prev) =>
          prev.some((m) => m.id === msg.message.id) ? prev : [...prev, msg.message as Message],
        );
      } else if (msg.type === 'error') {
        setError(`server: ${msg.error}`);
      }
    });

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [room, auth.token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    // Round 3 left WS as the send path but WS isn't auth-aware. Round 4 adds
    // a paywall that must fire on send, and the paywall lives on the HTTP
    // POST path. So we move send to POST /api/messages (authoritative auth +
    // quota path) and let WS carry only inbound broadcasts. The DO still
    // accepts WS `send` frames for back-compat / future direct-WS clients,
    // but the UI no longer uses them.
    setError(null);
    try {
      const r = await fetch('/api/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ room, text }),
      });
      if (r.status === 402) {
        const body = (await r.json()) as { error?: string; reason?: string; quota?: { used: number; limit: number } };
        setError(`${body.error ?? 'QUOTA_EXCEEDED'} · ${body.reason ?? ''} (${body.quota?.used ?? '?'}/${body.quota?.limit ?? '?'})`);
        // Refresh billing so the banner reflects the new used count.
        refreshBilling();
        return;
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(`send failed: HTTP ${r.status} ${body.error ?? ''}`);
        return;
      }
      setDraft('');
    } catch (e) {
      setError(`send error: ${String(e)}`);
    }
  };

  // Mock upgrade CTA: runs the full checkout→confirm→refresh flow inline.
  const upgrade = async () => {
    setUpgrading(true);
    setError(null);
    try {
      await runMockUpgrade(auth.token);
      await refreshBilling();
    } catch (e) {
      setError(`upgrade failed: ${String(e)}`);
    } finally {
      setUpgrading(false);
    }
  };

  const statusColor = useMemo(
    () => (status === 'open' ? '#22c55e' : status === 'connecting' ? '#eab308' : '#ef4444'),
    [status],
  );

  const isPaid = billing?.status === 'paid';
  const quotaText = billing
    ? isPaid
      ? 'unlimited (paid)'
      : `free: ${billing.quota.remaining} / ${billing.quota.limit} msgs left today`
    : null;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>chat-saas · MVP</h1>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: '#555' }}>
          {auth.email} · <a href="#" onClick={onLogout} style={{ color: '#555' }}>logout</a>
        </span>
      </div>

      {/* Round 4: billing banner. Free users see quota + upgrade CTA.
          The 402 path also flips `error` so the user is prompted inline. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 8,
          marginBottom: 8,
          borderRadius: 4,
          background: isPaid ? '#ecfdf5' : '#fff7ed',
          border: `1px solid ${isPaid ? '#a7f3d0' : '#fed7aa'}`,
          fontSize: 13,
        }}
      >
        <span style={{ flex: 1 }}>
          <strong style={{ marginRight: 6 }}>{isPaid ? 'paid' : 'free'}</strong>
          {quotaText}
        </span>
        {!isPaid && (
          <button
            onClick={upgrade}
            disabled={upgrading}
            style={{ padding: '4px 10px', cursor: upgrading ? 'wait' : 'pointer' }}
          >
            {upgrading ? 'upgrading…' : 'upgrade (mock)'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <label>
          room
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{ marginLeft: 6, padding: 4, width: 140 }}
          />
        </label>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginLeft: 'auto',
            color: statusColor,
            fontSize: 13,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor }} />
          {status}
        </span>
      </div>

      {error && (
        <div style={{ background: '#fee', color: '#900', padding: 8, marginBottom: 8, borderRadius: 4 }}>
          {error}
          {/QUOTA_EXCEEDED|free_daily_quota/.test(error) && !upgrading && (
            <button
              onClick={upgrade}
              style={{ marginLeft: 8, padding: '2px 8px', cursor: 'pointer' }}
            >
              upgrade now
            </button>
          )}
        </div>
      )}

      <div
        style={{
          border: '1px solid #ddd',
          borderRadius: 6,
          height: 360,
          overflowY: 'auto',
          padding: 8,
          background: '#fafafa',
        }}
      >
        {messages.length === 0 && <div style={{ color: '#999' }}>no messages yet</div>}
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 6 }}>
            <span style={{ color: '#666', fontSize: 12, marginRight: 8 }}>
              {new Date(m.createdAt).toLocaleTimeString()}
            </span>
            <strong style={{ marginRight: 6 }}>{m.user}:</strong>
            <span>{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{ display: 'flex', gap: 8, marginTop: 8 }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="say something…"
          maxLength={2000}
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={!draft.trim()} style={{ padding: '8px 16px' }}>
          send
        </button>
      </form>
    </div>
  );
}
