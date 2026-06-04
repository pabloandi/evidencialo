#!/usr/bin/env bash
# Integration harness for the sanitize-video Edge Function (step09).
#
# Exercises the integrated state machine + storage + visibility trigger against
# the LOCAL Supabase stack — the part the portable vitest units (mp4.ts/retry.ts)
# cannot cover. Asserts:
#   SCEN-001/003  good video  -> 200, processed, is_visible=true, NO location tag
#   SCEN-002      corrupt obj  -> >=400, failed, is_visible=false
#   SCEN-004      re-invoke    -> 200, still 1 row, still processed (idempotent)
#   SCEN-H01      missing obj  -> 409, row stays 'pending' (NOT failed)
#   FIX A (jwt)   no bearer    -> 401 (gateway rejects before the handler)
#
# Exits non-zero on the FIRST failed assertion.
#
# Prereqs: a running local stack (`supabase start`), the function served on
# :54321 (this script serves it itself if --serve is passed, else assumes it is
# already served), and ffmpeg/ffprobe/jq/psql/curl on PATH.
#
# Manual run:
#   bash supabase/functions/sanitize-video/integration.test.sh --serve
# CI wires it with the function served in the background (see db.yml).

set -euo pipefail

# Resolve the supabase CLI: it is usually a project devDependency (pnpm), not a
# global, so prefer the local bin. Override with SUPABASE_BIN if needed.
if [ -z "${SUPABASE_BIN:-}" ]; then
  if command -v supabase >/dev/null 2>&1; then
    SUPABASE_BIN="supabase"
  else
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
    if [ -x "$repo_root/node_modules/.bin/supabase" ]; then
      SUPABASE_BIN="$repo_root/node_modules/.bin/supabase"
    else
      echo "FATAL: supabase CLI not found (set SUPABASE_BIN)"; exit 2
    fi
  fi
fi
supabase() { "$SUPABASE_BIN" "$@"; }

API_URL="${API_URL:-http://127.0.0.1:54321}"
FN_URL="$API_URL/functions/v1/sanitize-video"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
BUCKET="report-media"
SERVE="${1:-}"

# --- pull keys from `supabase status` (env format) -------------------------
status_env="$(supabase status -o env 2>/dev/null)"
get() { printf '%s\n' "$status_env" | sed -n "s/^$1=\"\\(.*\\)\"$/\\1/p"; }
SERVICE_ROLE="$(get SERVICE_ROLE_KEY)"
ANON="$(get ANON_KEY)"
[ -n "$SERVICE_ROLE" ] || { echo "FATAL: could not read SERVICE_ROLE_KEY from supabase status"; exit 2; }
[ -n "$ANON" ] || { echo "FATAL: could not read ANON_KEY from supabase status"; exit 2; }

WORK="$(mktemp -d)"
SERVE_PID=""
cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "ASSERT FAIL: $*"; exit 1; }
ok()   { echo "  ok: $*"; }

psql_x() { psql "$DB_URL" -tA -c "$1"; }

# --- optionally serve the function -----------------------------------------
if [ "$SERVE" = "--serve" ]; then
  echo "== serving sanitize-video =="
  SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE" supabase functions serve sanitize-video \
    >"$WORK/serve.log" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN_URL" \
      -H "Authorization: Bearer $ANON" -H 'content-type: application/json' -d '{}' || true)"
    # 400 (bad body, but reached handler) means it is up and JWT passed.
    [ "$code" = "400" ] && break
    sleep 1
  done
fi

# --- fixtures --------------------------------------------------------------
GOOD="$WORK/good.mp4"
ffmpeg -y -f lavfi -i testsrc=duration=1:size=160x120:rate=5 \
  -metadata location="+40.0-074.0/" "$GOOD" >/dev/null 2>&1
head -c 4096 /dev/urandom > "$WORK/corrupt.bin"

ensure_category() {
  local id
  id="$(psql_x "select id from public.categories limit 1;")"
  if [ -z "$id" ]; then
    id="$(psql_x "insert into public.categories (slug, name) values ('it-sv','IT SV') returning id;")"
  fi
  echo "$id"
}

# create_report (service-role RPC) returns { report_id, media:[{id,...,storage_path}] }
seed_report() {
  local cat="$1"
  curl -s -X POST "$API_URL/rest/v1/rpc/create_report" \
    -H "Authorization: Bearer $SERVICE_ROLE" -H "apikey: $SERVICE_ROLE" \
    -H 'content-type: application/json' \
    -d "{\"p_category_id\":\"$cat\",\"p_lng\":-74.0,\"p_lat\":4.6,\"p_description\":\"it-sv\",\"p_idempotency_key\":null,\"p_media\":[{\"storage_path\":\"0.mp4\",\"type\":\"video\",\"duration_s\":1}]}"
}

upload_obj() { # path file content-type
  curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/storage/v1/object/$BUCKET/$1" \
    -H "Authorization: Bearer $SERVICE_ROLE" \
    -H "content-type: $3" -H "x-upsert: true" --data-binary "@$2"
}

invoke() { # report_id media_id [bearer]
  local bearer="${3:-$ANON}"
  curl -s -w '\n%{http_code}' -X POST "$FN_URL" \
    -H "Authorization: Bearer $bearer" -H 'content-type: application/json' \
    -d "{\"report_id\":\"$1\",\"media_id\":\"$2\"}"
}

CAT="$(ensure_category)"

# ===========================================================================
echo "== SCEN-001/003: good video publishes + strips location =="
r="$(seed_report "$CAT")"
RID="$(echo "$r" | jq -r '.report_id')"
MID="$(echo "$r" | jq -r '.media[0].id')"
PATH_="$(echo "$r" | jq -r '.media[0].storage_path')"
[ "$(upload_obj "$PATH_" "$GOOD" video/mp4)" = "200" ] || fail "upload good mp4"

resp="$(invoke "$RID" "$MID")"; body="$(echo "$resp" | head -n1)"; code="$(echo "$resp" | tail -n1)"
echo "  invoke#1: $code $body"
[ "$code" = "200" ] || fail "SCEN-001 expected 200, got $code"
[ "$(psql_x "select processing_state from public.report_media where id='$MID';")" = "processed" ] || fail "SCEN-001 not processed"
[ "$(psql_x "select is_visible from public.reports where id='$RID';")" = "t" ] || fail "SCEN-001 report not visible"
# download stored object, ffprobe must show NO location.
curl -s "$API_URL/storage/v1/object/authenticated/$BUCKET/$PATH_" \
  -H "Authorization: Bearer $SERVICE_ROLE" -o "$WORK/stored.mp4"
tags="$(ffprobe -v error -show_entries format_tags -of default=noprint_wrappers=1 "$WORK/stored.mp4")"
echo "$tags" | grep -qi location && fail "SCEN-003 location tag still present:\n$tags"
ffprobe -v error -show_entries stream=codec_type -of default=nokey=1:noprint_wrappers=1 "$WORK/stored.mp4" | grep -qx video || fail "SCEN-003 stored video corrupt (no video stream)"
ok "processed, visible, no location, video intact"

echo "== SCEN-004: idempotent re-invoke =="
resp="$(invoke "$RID" "$MID")"; code="$(echo "$resp" | tail -n1)"
echo "  invoke#2: $code $(echo "$resp" | head -n1)"
[ "$code" = "200" ] || fail "SCEN-004 expected 200, got $code"
cnt="$(psql_x "select count(*) from public.report_media where report_id='$RID' and storage_path='$PATH_';")"
[ "$cnt" = "1" ] || fail "SCEN-004 duplicate rows: $cnt"
[ "$(psql_x "select processing_state from public.report_media where id='$MID';")" = "processed" ] || fail "SCEN-004 state changed"
ok "still 200, 1 row, processed"

echo "== SCEN-002: corrupt object -> failed, not visible =="
r="$(seed_report "$CAT")"
RID2="$(echo "$r" | jq -r '.report_id')"; MID2="$(echo "$r" | jq -r '.media[0].id')"; PATH2="$(echo "$r" | jq -r '.media[0].storage_path')"
[ "$(upload_obj "$PATH2" "$WORK/corrupt.bin" video/mp4)" = "200" ] || fail "upload corrupt"
resp="$(invoke "$RID2" "$MID2")"; code="$(echo "$resp" | tail -n1)"
echo "  invoke corrupt: $code $(echo "$resp" | head -n1)"
[ "$code" -ge 400 ] || fail "SCEN-002 expected >=400, got $code"
[ "$(psql_x "select processing_state from public.report_media where id='$MID2';")" = "failed" ] || fail "SCEN-002 not failed"
[ "$(psql_x "select is_visible from public.reports where id='$RID2';")" = "f" ] || fail "SCEN-002 report visible despite failure"
ok "failed, not visible, status $code"

echo "== SCEN-H01: missing object -> 409, row stays pending =="
r="$(seed_report "$CAT")"
RID3="$(echo "$r" | jq -r '.report_id')"; MID3="$(echo "$r" | jq -r '.media[0].id')"
# deliberately DO NOT upload the object.
resp="$(invoke "$RID3" "$MID3")"; code="$(echo "$resp" | tail -n1)"
echo "  invoke missing: $code $(echo "$resp" | head -n1)"
[ "$code" = "409" ] || fail "SCEN-H01 expected 409, got $code"
[ "$(psql_x "select processing_state from public.report_media where id='$MID3';")" = "pending" ] || fail "SCEN-H01 row not still pending"
ok "409 not-ready, row stays pending (retryable)"

echo "== FIX A: verify_jwt rejects an unauthenticated request =="
noauth="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN_URL" \
  -H 'content-type: application/json' -d "{\"report_id\":\"$RID\",\"media_id\":\"$MID\"}")"
echo "  no-bearer status: $noauth"
[ "$noauth" = "401" ] || fail "FIX A expected 401 without bearer, got $noauth"
ok "gateway rejects unauthenticated (401)"

echo "== ALL INTEGRATION ASSERTIONS PASSED =="
