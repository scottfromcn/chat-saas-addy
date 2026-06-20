#!/usr/bin/env bash
# Round 4 paywall e2e. Run against `wrangler dev` already up.
# Exercises: register (free) → status free → burn 50 msgs → 51st = 402
#            → checkout → confirm → status paid → msg 52 succeeds.
set -uo pipefail

BASE="${BASE:-http://localhost:8788}"
EMAIL="paywall$$_$(date +%s)@example.com"
PASS="hunter2pass"

echo "BASE=$BASE  EMAIL=$EMAIL"
echo

pp() { printf '%s\n' "$1"; }

echo "=== 1. register (expect 201 + token) ==="
REG=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
REG_BODY=$(echo "$REG" | head -n1)
REG_CODE=$(echo "$REG" | tail -n1)
echo "$REG_BODY"
echo "HTTP $REG_CODE"
TOKEN=$(echo "$REG_BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
test -n "$TOKEN" && echo "TOKEN len=${#TOKEN}" || { echo "NO TOKEN"; exit 1; }
echo

echo "=== 2. GET /api/billing/status (expect status=free, limit=50) ==="
curl -s "$BASE/api/billing/status" -H "authorization: Bearer $TOKEN"
echo; echo

echo "=== 3. D1: confirm subscription row is free ==="
pnpm --silent wrangler d1 execute chat-saas --local --command \
  "SELECT u.email, s.status, s.plan FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE u.email='$EMAIL'" 2>&1 \
  | grep -E 'email|status|free|paid' | head -5
echo

echo "=== 4. POST 50 messages (should all be 201) ==="
FAIL=0
for i in $(seq 1 50); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/messages" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"room\":\"general\",\"text\":\"msg $i\"}")
  if [ "$CODE" != "201" ]; then
    echo "  msg $i → HTTP $CODE (unexpected)"
    FAIL=$((FAIL+1))
    [ "$FAIL" -ge 3 ] && break
  fi
done
echo "  → 50 POSTs done, unexpected=$FAIL"
echo

echo "=== 5. GET /api/billing/status (expect remaining=0) ==="
curl -s "$BASE/api/billing/status" -H "authorization: Bearer $TOKEN"
echo; echo

echo "=== 6. POST 51st message (expect 402 QUOTA_EXCEEDED) ==="
R51=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/messages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"room":"general","text":"should be blocked"}')
echo "$(echo "$R51" | head -n1)"
echo "HTTP $(echo "$R51" | tail -n1)"
echo

echo "=== 7. POST /api/billing/checkout (expect 201 + sessionId + url) ==="
CO=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/billing/checkout" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"plan":"pro"}')
echo "$(echo "$CO" | head -n1)"
echo "HTTP $(echo "$CO" | tail -n1)"
URL=$(echo "$CO" | head -n1 | python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
SID=$(echo "$CO" | head -n1 | python3 -c 'import sys,json;print(json.load(sys.stdin)["sessionId"])')
echo "URL=$URL"
echo "SID=$SID"
echo

echo "=== 8. POST <url> (mock Stripe return URL → /confirm, expect ok=true paid) ==="
CF=$(curl -s -w '\n%{http_code}' -X POST "$URL")
echo "$(echo "$CF" | head -n1)"
echo "HTTP $(echo "$CF" | tail -n1)"
echo

echo "=== 9. GET /api/billing/status (expect status=paid, limit=null) ==="
curl -s "$BASE/api/billing/status" -H "authorization: Bearer $TOKEN"
echo; echo

echo "=== 10. POST 52nd message (expect 201 — paid, no more quota) ==="
R52=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/messages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"room":"general","text":"after paid, should work"}')
echo "$(echo "$R52" | head -n1)"
echo "HTTP $(echo "$R52" | tail -n1)"
echo

echo "=== 11. webhook with bogus session_id (expect 400 UNKNOWN_SESSION) ==="
WB=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/billing/webhook" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"cs_test_bogus_999"}')
echo "$(echo "$WB" | head -n1)"
echo "HTTP $(echo "$WB" | tail -n1)"
echo

echo "=== 12. webhook with no auth, by email (dev harness path, expect ok) ==="
WB2=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/billing/webhook" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}")
echo "$(echo "$WB2" | head -n1)"
echo "HTTP $(echo "$WB2" | tail -n1)"
echo

echo "=== 13. checkout without auth (expect 401) ==="
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/billing/checkout" \
  -H 'content-type: application/json' -d '{"plan":"pro"}')
echo "HTTP $NOAUTH"
echo

echo "=== 14. D1: final subscription row state ==="
pnpm --silent wrangler d1 execute chat-saas --local --command \
  "SELECT u.email, s.status, s.plan, s.current_period_end FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE u.email='$EMAIL'" 2>&1 \
  | grep -E 'email|paid|pro|current_period_end' | head -5
echo

echo "=== DONE ==="
