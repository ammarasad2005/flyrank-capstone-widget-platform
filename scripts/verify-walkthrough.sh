#!/usr/bin/env bash
# End-to-end walkthrough of every externally checkable promise in the capstone brief.
#
# Run against a live stack:
#   docker compose up -d --build --wait app
#   docker compose exec app npm run seed
#   bash scripts/verify-walkthrough.sh
#
# It prints one PASS/FAIL line per check and a transcript of the actual HTTP responses.
# Some checks intentionally exhaust the per-IP rate limit; the script restarts the API
# container between sections so each section starts with fresh in-process buckets
# (documented limitation: buckets are per-process and reset on restart).
set -uo pipefail

API="${API_URL:-http://127.0.0.1:3000}"
ORIGIN="${PROBE_ORIGIN:-http://localhost:5500}"
WIDGET="${WIDGET_PUBLIC_ID:-demo-contact-widget-a}"
PASS=0
FAIL=0
# Unique per run so a repeat run is a new submission rather than an idempotent replay.
RUN_KEY="walkthrough-$(date +%s)-$$"

say()  { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
check() { if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }

restart_api() {
  if command -v docker >/dev/null 2>&1; then
    docker compose up -d --force-recreate app >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do
      curl -fsS "$API/ready" >/dev/null 2>&1 && return 0
      sleep 0.5
    done
  fi
  return 0
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

json_field() { jq -r "$1" 2>/dev/null; }

# ---------------------------------------------------------------- owner + widgets
restart_api
say "A. Owner authentication and widget management (Section 4.1, 6.x)"

UNAUTH=$(code "$API/api/widgets")
[ "$UNAUTH" = "401" ] && ok "unauthenticated GET /api/widgets → 401" || bad "unauthenticated GET /api/widgets → $UNAUTH"

LOGIN_A=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"owner-a@example.test","password":"demo-owner-a-password"}')
TOKEN_A=$(printf '%s' "$LOGIN_A" | json_field .accessToken)
[ -n "${TOKEN_A:-}" ] && [ "$TOKEN_A" != "null" ] && ok "POST /auth/login (tenant A) → Bearer token" || bad "login A failed: $LOGIN_A"

BAD_LOGIN=$(code -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"owner-a@example.test","password":"wrong-password"}')
[ "$BAD_LOGIN" = "401" ] && ok "wrong password → 401" || bad "wrong password → $BAD_LOGIN"

TOKEN_B=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"owner-b@example.test","password":"demo-owner-b-password"}' | json_field .accessToken)
[ -n "${TOKEN_B:-}" ] && [ "$TOKEN_B" != "null" ] && ok "POST /auth/login (tenant B) → Bearer token" || bad "login B failed"

LIST_A=$(body "$API/api/widgets" -H "authorization: Bearer $TOKEN_A")
WIDGET_ID=$(printf '%s' "$LIST_A" | json_field '.widgets[0].id')
SNIPPET=$(printf '%s' "$LIST_A" | json_field '.widgets[0].embed.snippet')
KINDS=$(printf '%s' "$LIST_A" | json_field '[.widgets[].kind] | join(",")')
echo "tenant A widgets: $KINDS"
echo "snippet: $SNIPPET"
[ "$SNIPPET" = "<script src=\"http://localhost:3000/public/widget.js?id=$WIDGET\" async></script>" ] \
  && ok "embed snippet generated per widget (exact one-line <script>)" || bad "unexpected snippet: $SNIPPET"

CREATED=$(curl -s -X POST "$API/api/widgets" -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -d '{"kind":"signup","title":"Tenant B newsletter","fields":[{"name":"email","label":"Email","type":"email","required":true,"maxLength":254}],"buttonText":"Subscribe","displayOptions":{"theme":"dark","position":"popover"},"allowedOrigins":["http://localhost:5500"]}')
WIDGET_B=$(printf '%s' "$CREATED" | json_field '.widget.id')
PUBLIC_B=$(printf '%s' "$CREATED" | json_field '.widget.publicId')
[ "$(printf '%s' "$CREATED" | json_field '.widget.kind')" = "signup" ] && ok "POST /api/widgets creates a second widget kind (signup) → 201" || bad "create widget failed: $CREATED"

V=$(printf '%s' "$CREATED" | json_field '.widget.version')
PATCHED=$(curl -s -X PATCH "$API/api/widgets/$WIDGET_B" -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -d '{"title":"Tenant B newsletter v2"}')
V2=$(printf '%s' "$PATCHED" | json_field '.widget.version')
[ "$V2" -gt "$V" ] 2>/dev/null && ok "PATCH /api/widgets/:id updates and increments version ($V → $V2)" || bad "patch failed: $PATCHED"

READ_OK=$(code "$API/api/widgets/$WIDGET_ID" -H "authorization: Bearer $TOKEN_A")
READ_CROSS=$(code "$API/api/widgets/$WIDGET_ID" -H "authorization: Bearer $TOKEN_B")
PATCH_CROSS=$(code -X PATCH "$API/api/widgets/$WIDGET_ID" -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' -d '{"title":"hijacked"}')
DELETE_CROSS=$(code -X DELETE "$API/api/widgets/$WIDGET_ID" -H "authorization: Bearer $TOKEN_B")
EMBED_CROSS=$(code "$API/api/widgets/$WIDGET_ID/embed" -H "authorization: Bearer $TOKEN_B")
[ "$READ_OK" = "200" ] && ok "tenant A reads its own widget → 200" || bad "self read → $READ_OK"
[ "$READ_CROSS$PATCH_CROSS$DELETE_CROSS$EMBED_CROSS" = "404404404404" ] \
  && ok "tenant B cannot read/patch/delete/embed tenant A's widget → 404 each" \
  || bad "cross-tenant widget access: read=$READ_CROSS patch=$PATCH_CROSS delete=$DELETE_CROSS embed=$EMBED_CROSS"

BAD_WIDGET=$(code -X POST "$API/api/widgets" -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' -d '{"kind":"nope","title":"","fields":[]}')
[ "$BAD_WIDGET" = "422" ] && ok "invalid widget body → 422 (boundary validation)" || bad "invalid widget body → $BAD_WIDGET"

EMBED=$(body "$API/api/widgets/$WIDGET_ID/embed" -H "authorization: Bearer $TOKEN_A")
echo "GET /api/widgets/$WIDGET_ID/embed → $(printf '%s' "$EMBED" | jq -c '{publicId, snippet, configUrl}' 2>/dev/null)"
[ "$(printf '%s' "$EMBED" | json_field .snippet)" = "$SNIPPET" ] && ok "GET /api/widgets/:id/embed returns the same snippet" || bad "embed endpoint mismatch"

# ---------------------------------------------------------------- public delivery
say "B. Public widget delivery: config, versioning, cache headers (Section 4.2-4.3)"

CFG_HEADERS=$(curl -s -D- -o /dev/null "$API/widgets/$WIDGET/config")
echo "$CFG_HEADERS" | sed -n '1,12p'
CACHE=$(printf '%s' "$CFG_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
ETAG=$(printf '%s' "$CFG_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
ACAO=$(printf '%s' "$CFG_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
CFG_BODY=$(body "$API/widgets/$WIDGET/config")
CFG_BYTES=$(printf '%s' "$CFG_BODY" | wc -c)
echo "config body (${CFG_BYTES} bytes): $CFG_BODY"
case "$CACHE" in *max-age=60*) ok "config has Cache-Control max-age=60 ($CACHE)";; *) bad "config cache header: $CACHE";; esac
[ -n "$ETAG" ] && ok "config carries an ETag ($ETAG)" || bad "config has no ETag"
[ "$ACAO" = "*" ] && ok "config is readable cross-origin (Access-Control-Allow-Origin: *)" || bad "config ACAO: $ACAO"
[ "$CFG_BYTES" -lt 2048 ] && ok "config payload stays small ($CFG_BYTES bytes)" || bad "config payload is large ($CFG_BYTES bytes)"
printf '%s' "$CFG_BODY" | grep -qi 'tenant\|owner-a@example' && bad "config leaks tenant/owner data" || ok "config contains no tenant id or owner email"

REVALIDATED=$(code "$API/widgets/$WIDGET/config" -H "if-none-match: $ETAG")
[ "$REVALIDATED" = "304" ] && ok "conditional GET with If-None-Match → 304" || bad "revalidation → $REVALIDATED"

BUNDLE_HEADERS=$(curl -s -D- -o /dev/null "$API/public/widget.v1.js")
BUNDLE_CACHE=$(printf '%s' "$BUNDLE_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
BUNDLE_TYPE=$(printf '%s' "$BUNDLE_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
BUNDLE_ETAG=$(printf '%s' "$BUNDLE_HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
BUNDLE_BYTES=$(body "$API/public/widget.v1.js" | wc -c)
echo "bundle: type=$BUNDLE_TYPE cache=$BUNDLE_CACHE bytes=$BUNDLE_BYTES"
case "$BUNDLE_CACHE" in *"max-age=31536000"*) ok "versioned bundle is immutable-cached ($BUNDLE_CACHE)";; *) bad "bundle cache header: $BUNDLE_CACHE";; esac
case "$BUNDLE_TYPE" in application/javascript*) ok "bundle served as JavaScript";; *) bad "bundle type: $BUNDLE_TYPE";; esac
[ "$(code "$API/public/widget.v1.js" -H "if-none-match: $BUNDLE_ETAG")" = "304" ] && ok "bundle revalidates with 304" || bad "bundle revalidation failed"
ALIAS=$(code "$API/public/widget.js?id=$WIDGET")
[ "$ALIAS" = "200" ] && ok "stable alias /public/widget.js serves the current bundle → 200" || bad "alias → $ALIAS"
STALE=$(code "$API/public/widget.v0.js")
[ "$STALE" = "410" ] && ok "old bundle version → 410 stale_widget_bundle" || bad "old version → $STALE"
UNKNOWN_CFG=$(code "$API/widgets/no-such-widget/config")
[ "$UNKNOWN_CFG" = "404" ] && ok "config for an unknown widget → 404" || bad "unknown widget config → $UNKNOWN_CFG"

ARCHIVED=$(code -X DELETE "$API/api/widgets/$WIDGET_B" -H "authorization: Bearer $TOKEN_B")
AFTER_ARCHIVE_CFG=$(code "$API/widgets/$PUBLIC_B/config")
AFTER_ARCHIVE_SUBMIT=$(code -X POST "$API/submissions?widget_id=$PUBLIC_B" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d '{"fields":{"email":"x@example.test"}}')
[ "$ARCHIVED" = "204" ] && ok "DELETE /api/widgets/:id archives the widget → 204" || bad "archive → $ARCHIVED"
[ "$AFTER_ARCHIVE_CFG" = "404" ] && ok "archived widget stops serving config → 404" || bad "archived config → $AFTER_ARCHIVE_CFG"
[ "$AFTER_ARCHIVE_SUBMIT" = "404" ] && ok "archived widget refuses submissions → 404" || bad "archived submit → $AFTER_ARCHIVE_SUBMIT"

# ---------------------------------------------------------------- submissions
restart_api
say "C. Public submission endpoint: CORS, preflight, validation, spam, persistence (Section 4.4)"

PREFLIGHT=$(curl -s -D- -o /dev/null -X OPTIONS "$API/submissions?widget_id=$WIDGET" \
  -H "origin: $ORIGIN" -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: content-type,idempotency-key')
echo "$PREFLIGHT" | sed -n '1,10p'
PF_CODE=$(printf '%s' "$PREFLIGHT" | head -1 | awk '{print $2}')
PF_ACAO=$(printf '%s' "$PREFLIGHT" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
PF_METHODS=$(printf '%s' "$PREFLIGHT" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-methods"{print $2}')
PF_HEADERS=$(printf '%s' "$PREFLIGHT" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-headers"{print $2}')
[ "$PF_CODE" = "204" ] && ok "OPTIONS preflight → 204" || bad "preflight → $PF_CODE"
[ "$PF_ACAO" = "$ORIGIN" ] && ok "preflight echoes the requesting origin ($PF_ACAO)" || bad "preflight ACAO: $PF_ACAO"
case "$PF_METHODS" in *POST*) ok "preflight allows POST ($PF_METHODS)";; *) bad "preflight methods: $PF_METHODS";; esac
printf '%s' "$PF_HEADERS" | grep -qi 'idempotency-key' && ok "preflight allows Content-Type + Idempotency-Key" || bad "preflight headers: $PF_HEADERS"

BAD_PREFLIGHT=$(code -X OPTIONS "$API/submissions?widget_id=$WIDGET" -H 'origin: https://evil.example' -H 'access-control-request-method: POST')
[ "$BAD_PREFLIGHT" = "403" ] && ok "preflight from a non-allowlisted origin → 403" || bad "bad-origin preflight → $BAD_PREFLIGHT"

ACCEPT=$(curl -s -D- -X POST "$API/submissions?widget_id=$WIDGET" \
  -H "origin: $ORIGIN" -H 'content-type: application/json' -H "idempotency-key: $RUN_KEY" \
  -d '{"fields":{"name":"Walkthrough Lead","email":"walkthrough@example.test","message":"End-to-end verification."}}')
echo "$ACCEPT" | sed -n '1,8p'
ACC_CODE=$(printf '%s' "$ACCEPT" | head -1 | awk '{print $2}')
ACC_ACAO=$(printf '%s' "$ACCEPT" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
ACC_BODY=$(printf '%s' "$ACCEPT" | sed -n '/^{/,$p')
SUB_ID=$(printf '%s' "$ACC_BODY" | json_field .submissionId)
echo "response body: $ACC_BODY"
[ "$ACC_CODE" = "201" ] && ok "cross-origin POST → 201 with submissionId $SUB_ID" || bad "cross-origin POST → $ACC_CODE"
[ "$ACC_ACAO" = "$ORIGIN" ] && ok "POST response carries CORS header for the allowed origin" || bad "POST ACAO: $ACC_ACAO"

REPLAY=$(curl -s -o /tmp/replay.json -w '%{http_code}' -X POST "$API/submissions?widget_id=$WIDGET" \
  -H "origin: $ORIGIN" -H 'content-type: application/json' -H "idempotency-key: $RUN_KEY" \
  -d '{"fields":{"name":"Walkthrough Lead","email":"walkthrough@example.test","message":"End-to-end verification."}}')
[ "$REPLAY" = "200" ] && [ "$(json_field .reused < /tmp/replay.json)" = "true" ] \
  && ok "repeated Idempotency-Key → 200 reused:true (same submission $SUB_ID)" || bad "idempotent replay → $REPLAY $(cat /tmp/replay.json)"

MALFORMED=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"fields":')
OVERSIZED=$(python3 -c 'import json;print(json.dumps({"fields":{"name":"x"*20000}}))' > /tmp/big.json; code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' --data-binary @/tmp/big.json)
INVALID_EMAIL=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"fields":{"name":"Bad","email":"not-an-email"}}')
UNKNOWN_FIELD=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"fields":{"name":"X","email":"x@example.test"},"tenantId":2}')
MISSING_REQUIRED=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"fields":{"email":"x@example.test"}}')
ARRAY_BODY=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '[]')
echo "malformed=$MALFORMED oversized=$OVERSIZED invalid_email=$INVALID_EMAIL unknown_field=$UNKNOWN_FIELD missing_required=$MISSING_REQUIRED array_body=$ARRAY_BODY"
{ [ "$MALFORMED" = "400" ] && [ "$OVERSIZED" = "413" ] && [ "$INVALID_EMAIL" = "422" ] && [ "$UNKNOWN_FIELD" = "422" ] && [ "$MISSING_REQUIRED" = "422" ] && [ "$ARRAY_BODY" = "422" ]; } \
  && ok "malformed → 400, oversized → 413, invalid/missing/unknown/array → 422 (never 500)" \
  || bad "validation status codes were malformed=$MALFORMED oversized=$OVERSIZED invalid=$INVALID_EMAIL unknown=$UNKNOWN_FIELD missing=$MISSING_REQUIRED array=$ARRAY_BODY"

BAD_ORIGIN_POST=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H 'origin: https://evil.example' -H 'content-type: application/json' \
  -d '{"fields":{"name":"Nope","email":"nope@example.test"}}')
[ "$BAD_ORIGIN_POST" = "403" ] && ok "POST from a non-allowlisted origin → 403" || bad "bad-origin POST → $BAD_ORIGIN_POST"

BEFORE=$(curl -s "$API/api/submissions?limit=1" -H "authorization: Bearer $TOKEN_A" | json_field .pagination.total)
HONEY=$(curl -s -o /tmp/honey.json -w '%{http_code}' -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d '{"fields":{"name":"Bot","email":"bot@example.test"},"website":"https://spam.example"}')
sleep 1
AFTER=$(curl -s "$API/api/submissions?limit=1" -H "authorization: Bearer $TOKEN_A" | json_field .pagination.total)
echo "honeypot response: $HONEY $(cat /tmp/honey.json); stored leads $BEFORE → $AFTER"
{ [ "$HONEY" = "202" ] && [ "$BEFORE" = "$AFTER" ]; } && ok "filled honeypot → 202 and no stored lead ($BEFORE → $AFTER)" \
  || bad "honeypot: response=$HONEY leads $BEFORE → $AFTER"

# ---------------------------------------------------------------- storage + tenancy
say "D. Persistence, tenant linkage, dashboard reads and statistics (Section 4.6, Section 6)"

STORED=$(docker compose exec -T db psql -U widget -d widget_platform -Atc \
  "SELECT s.id||'|'||s.tenant_id||'|'||s.widget_id||'|'||w.public_id||'|'||w.tenant_id||'|'||coalesce(s.geo_country,'null')||'|'||(SELECT count(*) FROM notification_jobs j WHERE j.submission_id=s.id) FROM submissions s JOIN widgets w ON w.id=s.widget_id WHERE s.id=$SUB_ID;")
echo "stored row (id|tenant|widget|public_id|widget_tenant|geo|null jobs): $STORED"
IFS='|' read -r S_ID S_TENANT S_WIDGET S_PUBLIC S_WTENANT S_GEO S_JOBS <<< "$STORED"
{ [ "$S_TENANT" = "$S_WTENANT" ] && [ "$S_PUBLIC" = "$WIDGET" ] && [ "$S_JOBS" = "1" ]; } \
  && ok "lead stored under the widget's tenant ($S_TENANT) with exactly one outbox job" \
  || bad "stored row linkage: $STORED"
[ "$S_GEO" = "null" ] && ok "geo columns are nullable and stored without a client-supplied IP ($S_GEO)" || echo "INFO  geo stored as $S_GEO"

DASH_LIST=$(curl -s "$API/api/submissions?limit=5" -H "authorization: Bearer $TOKEN_A")
echo "GET /api/submissions → $(printf '%s' "$DASH_LIST" | jq -c '{count: (.submissions|length), pagination}' 2>/dev/null)"
printf '%s' "$DASH_LIST" | json_field '.submissions[0].id' | grep -qx "$SUB_ID" && ok "dashboard API lists the stored lead" || bad "dashboard list missing lead"
DASH_ONE=$(code "$API/api/submissions/$SUB_ID" -H "authorization: Bearer $TOKEN_A")
DASH_ONE_B=$(code "$API/api/submissions/$SUB_ID" -H "authorization: Bearer $TOKEN_B")
LIST_B=$(curl -s "$API/api/submissions?limit=5" -H "authorization: Bearer $TOKEN_B" | json_field .pagination.total)
STATS_B=$(curl -s "$API/api/stats?days=30" -H "authorization: Bearer $TOKEN_B" | json_field .totals.submissions)
[ "$DASH_ONE" = "200" ] && ok "owner reads own submission → 200" || bad "own submission read → $DASH_ONE"
[ "$DASH_ONE_B" = "404" ] && ok "tenant B reading tenant A's submission → 404" || bad "cross-tenant submission read → $DASH_ONE_B"
[ "$LIST_B" = "0" ] && [ "$STATS_B" = "0" ] && ok "tenant B list/stats totals are 0 (submissions isolated)" || bad "tenant B totals: list=$LIST_B stats=$STATS_B"

STATS=$(curl -s "$API/api/stats?days=7" -H "authorization: Bearer $TOKEN_A")
echo "GET /api/stats?days=7 → $(printf '%s' "$STATS" | jq -c '{totals, days: (.byDay|length), lastDay: .byDay[-1], byWidget, byCountry}' 2>/dev/null)"
{ [ "$(printf '%s' "$STATS" | json_field '.byDay|length')" = "7" ] \
  && [ "$(printf '%s' "$STATS" | json_field '.byWidget[0].publicId')" = "$WIDGET" ] \
  && [ "$(printf '%s' "$STATS" | json_field '.totals.submissions')" -ge 1 ] \
  && [ -n "$(printf '%s' "$STATS" | json_field '.byCountry[0].country')" ]; } \
  && ok "stats expose totals, zero-filled counts over time, per-widget stats, and geo breakdown" \
  || bad "stats payload incomplete"

# ---------------------------------------------------------------- abuse controls
restart_api
say "E. Abuse protection: burst throttling without losing service (Section 4.5, probe 3)"

LIMITED=""
for i in $(seq 1 15); do
  C=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d "{\"fields\":{\"name\":\"burst $i\",\"email\":\"burst$i@example.test\"}}")
  if [ "$C" = "429" ]; then LIMITED=$i; break; fi
done
RETRY_AFTER=$(curl -s -D- -o /dev/null -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d '{"fields":{"name":"burst","email":"burst@example.test"}}' | tr -d '\r' | awk -F': ' 'tolower($1)=="retry-after"{print $2}')
HEALTH_DURING=$(code "$API/health")
CFG_DURING=$(code "$API/widgets/$WIDGET/config")
echo "first 429 after $LIMITED submissions; Retry-After: ${RETRY_AFTER:-none}s; /health=$HEALTH_DURING config=$CFG_DURING"
[ -n "$LIMITED" ] && ok "burst of submissions is throttled with 429" || bad "no 429 within 15 submissions"
{ [ -n "$RETRY_AFTER" ] && [ "$RETRY_AFTER" -ge 1 ]; } && ok "429 carries Retry-After (${RETRY_AFTER}s)" || bad "429 missing Retry-After"
[ "$HEALTH_DURING" = "200" ] && [ "$CFG_DURING" = "200" ] && ok "API keeps serving other traffic during the throttle" || bad "service degraded: health=$HEALTH_DURING config=$CFG_DURING"
sleep "$(( ${RETRY_AFTER:-1} + 1 ))"
RECOVERED=$(code -X POST "$API/submissions?widget_id=$WIDGET" -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"fields":{"name":"After burst","email":"after@example.test"}}')
[ "$RECOVERED" = "201" ] && ok "legitimate request succeeds after Retry-After → 201" || bad "post-burst request → $RECOVERED"

# ---------------------------------------------------------------- outbox
say "F. Durable notification side effect (Section 4.5, shared requirement 3)"
sleep 3
JOBS=$(docker compose exec -T db psql -U widget -d widget_platform -Atc \
  "SELECT status||':'||attempts||':'||idempotency_key FROM notification_jobs ORDER BY id DESC LIMIT 3;")
echo "recent notification jobs (status:attempts:key):"; printf '%s\n' "$JOBS"
printf '%s' "$JOBS" | grep -q '^succeeded:' && ok "worker delivered queued notifications (succeeded in the outbox)" || bad "no succeeded job found"
docker compose logs --no-color --tail=200 app 2>/dev/null | grep -c 'confirmation_notification_sent' | xargs -I{} echo "confirmation_notification_sent log lines: {}"
SUB_COUNT=$(docker compose exec -T db psql -U widget -d widget_platform -Atc "SELECT count(*) FROM submissions;")
JOB_COUNT=$(docker compose exec -T db psql -U widget -d widget_platform -Atc "SELECT count(*) FROM notification_jobs;")
echo "submissions=$SUB_COUNT notification_jobs=$JOB_COUNT (one job per stored submission)"
[ "$SUB_COUNT" = "$JOB_COUNT" ] && ok "every stored submission has exactly one outbox job" || bad "jobs ($JOB_COUNT) != submissions ($SUB_COUNT)"

printf '\n=== SUMMARY: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
