#!/usr/bin/env bash
# Phase 1 human-watch API smoke (requires valid session cookie).
# Usage:
#   export MC_BASE=http://127.0.0.1:5000
#   export MC_COOKIE='mc_session=...'
#   ./scripts/human-watch-e2e-smoke.sh

set -euo pipefail

MC_BASE="${MC_BASE:-http://127.0.0.1:5000}"
if [[ -z "${MC_COOKIE:-}" ]]; then
  echo "Set MC_COOKIE (e.g. mc_session=...) from browser after login." >&2
  exit 1
fi

AUTH=(-H "Cookie: $MC_COOKIE")

echo "== GET policy =="
curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/policy" | jq .

echo "== PATCH policy enabled =="
curl -sS -X PATCH "${AUTH[@]}" "$MC_BASE/api/human-watch/policy" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' | jq .

echo "== GET bridge clients =="
CLIENTS=$(curl -sS "${AUTH[@]}" "$MC_BASE/api/bridge/clients")
echo "$CLIENTS" | jq .
CLIENT_ID="${HW_CLIENT_ID:-$(echo "$CLIENTS" | jq -r '.clients[0].id // empty')}"
if [[ -z "$CLIENT_ID" ]]; then
  echo "No bridge client online. Start mission-control-client with MC_REMOTE_SERVER_URL." >&2
  exit 1
fi
echo "Using client_id=$CLIENT_ID"

if [[ "${HW_SKIP_CREATE:-}" != "1" ]]; then
  echo "== POST steward (set HW_SKIP_CREATE=1 to skip) =="
  curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/human-watch/stewards" \
    -H "Content-Type: application/json" \
    -d "{\"client_id\":\"$CLIENT_ID\",\"name\":\"hw-smoke-steward\",\"framework\":\"claude-code\"}" | jq .
fi

echo "== GET bindings =="
curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/bindings" | jq .

BINDING_ID="${HW_BINDING_ID:-}"
if [[ -z "$BINDING_ID" ]]; then
  BINDING_ID=$(curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/bindings" | jq -r '.bindings[0].id // empty')
fi

if [[ -n "$BINDING_ID" ]]; then
  echo "== POST evaluate binding_id=$BINDING_ID =="
  curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/human-watch/evaluate" \
    -H "Content-Type: application/json" \
    -d "{\"binding_id\":$BINDING_ID}" | jq .
else
  echo "No binding; create one in UI or set HW_BINDING_ID" >&2
fi

echo "== GET interventions (last 10) =="
curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/interventions?client_id=$CLIENT_ID&limit=10" | jq .

echo "Done."
