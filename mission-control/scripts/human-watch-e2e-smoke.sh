#!/usr/bin/env bash
# Human-watch API smoke.
# Usage:
#   export MC_BASE=http://127.0.0.1:5000
#   export MC_COOKIE='mc_session=...'   # optional when auth is disabled locally
#   ./scripts/human-watch-e2e-smoke.sh

set -euo pipefail

MC_BASE="${MC_BASE:-http://127.0.0.1:5000}"
AUTH=()
if [[ -n "${MC_COOKIE:-}" ]]; then
  AUTH=(-H "Cookie: $MC_COOKIE")
fi

wait_for_event_id() {
  local request_id="$1"
  local event_id=""
  for _ in 1 2 3 4 5 6; do
    event_id="$(
      curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/events?client_id=$CLIENT_ID&permission_request_id=$request_id&limit=10" \
        | jq -r '.events[0].id // empty'
    )"
    if [[ -n "$event_id" && "$event_id" != "null" ]]; then
      echo "$event_id"
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "== GET policy =="
curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/policy" | jq .

echo "== GET bridge clients =="
CLIENTS=$(curl -sS "${AUTH[@]}" "$MC_BASE/api/bridge/clients")
echo "$CLIENTS" | jq .
CLIENT_ID="${HW_CLIENT_ID:-$(echo "$CLIENTS" | jq -r '.clients[0].id // empty')}"
if [[ -n "$CLIENT_ID" ]]; then
  echo "Using client_id=$CLIENT_ID"
else
  echo "No bridge client online; continuing with local/manual watch-event validation."
  CLIENT_ID="${HW_CLIENT_ID:-local-fallback}"
fi

echo "== POST permission request (watch event seed) =="
PR_PAYLOAD=$(cat <<JSON
{
  "id": "hw-smoke-pr-$(date +%s)",
  "client_id": "$CLIENT_ID",
  "worker_local_agent_id": ${HW_WORKER_LOCAL_AGENT_ID:-5},
  "worker_name": "${HW_WORKER_NAME:-hw-smoke-worker}",
  "worker_session_id": "${HW_WORKER_SESSION_ID:-hw-smoke-session}",
  "steward_local_agent_id": ${HW_STEWARD_LOCAL_AGENT_ID:-9},
  "steward_name": "${HW_STEWARD_NAME:-hw-smoke-steward}",
  "request_type": "local_cli_permission",
  "title": "Smoke: worker waiting for watch",
  "prompt": "Worker is waiting for steward intervention.",
  "risk": "medium",
  "options": [
    { "id": "approve_once", "label": "Approve once", "action": "approve" },
    { "id": "deny", "label": "Deny", "action": "deny" }
  ],
  "context": {
    "watch_event": {
      "source": "worker_tool"
    }
  }
}
JSON
)
PR_RESPONSE=$(curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/permission-requests" \
  -H "Content-Type: application/json" \
  -d "$PR_PAYLOAD")
echo "$PR_RESPONSE" | jq .
PR_ID="$(echo "$PR_RESPONSE" | jq -r '.request.id // empty')"

echo "== GET human watch events =="
EVENTS_RESPONSE=$(curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/events?client_id=$CLIENT_ID&limit=20")
echo "$EVENTS_RESPONSE" | jq .
EVENT_ID="${HW_EVENT_ID:-$(echo "$EVENTS_RESPONSE" | jq -r --arg PR_ID "$PR_ID" '.events[] | select(.permission_request_id == $PR_ID) | .id' | head -n 1)}"
if [[ -z "$EVENT_ID" || "$EVENT_ID" == "null" ]]; then
  EVENT_ID="$(wait_for_event_id "$PR_ID" || true)"
fi

if [[ -n "$EVENT_ID" ]]; then
  echo "== POST human watch action approve_request =="
  curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/human-watch/events/$EVENT_ID/action" \
    -H "Content-Type: application/json" \
    -d '{"action":"approve_request","note":"smoke approval"}' | jq .
  echo "== GET request after approval =="
  curl -sS "${AUTH[@]}" "$MC_BASE/api/permission-requests/$PR_ID" | jq .
  echo "== GET event after approval =="
  curl -sS "${AUTH[@]}" "$MC_BASE/api/human-watch/events?client_id=$CLIENT_ID&permission_request_id=$PR_ID&limit=10" | jq .
else
  echo "No watch event found for smoke permission request" >&2
fi

if [[ -n "${HW_LOCAL_SESSION_ID:-}" ]]; then
  echo "== POST local send_message_to_worker =="
  SEND_PAYLOAD=$(cat <<JSON
{
  "id": "hw-smoke-send-$(date +%s)",
  "client_id": "$CLIENT_ID",
  "worker_local_agent_id": ${HW_WORKER_LOCAL_AGENT_ID:-5},
  "worker_name": "${HW_WORKER_NAME:-hw-smoke-worker}",
  "worker_session_id": "${HW_LOCAL_SESSION_ID}",
  "request_type": "local_cli_permission",
  "title": "Smoke: send message to worker",
  "prompt": "Worker waits for a steward reply.",
  "risk": "medium",
  "options": [
    { "id": "approve_once", "label": "Approve once", "action": "approve" },
    { "id": "deny", "label": "Deny", "action": "deny" }
  ],
  "context": {
    "watch_event": { "source": "worker_tool" },
    "session_kind": "${HW_LOCAL_SESSION_KIND:-codex-cli}"
  }
}
JSON
)
  SEND_RESPONSE=$(curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/permission-requests" \
    -H "Content-Type: application/json" \
    -d "$SEND_PAYLOAD")
  echo "$SEND_RESPONSE" | jq .
  SEND_PR_ID="$(echo "$SEND_RESPONSE" | jq -r '.request.id // empty')"
  SEND_EVENT_ID="$(wait_for_event_id "$SEND_PR_ID" || true)"
  if [[ -n "$SEND_EVENT_ID" ]]; then
    curl -sS -X POST "${AUTH[@]}" "$MC_BASE/api/human-watch/events/$SEND_EVENT_ID/action" \
      -H "Content-Type: application/json" \
      -d "{\"action\":\"send_message_to_worker\",\"message\":\"${HW_LOCAL_SEND_MESSAGE:-值守测试：请继续执行，并简短回复已收到。}\"}" | jq .
  fi
fi

echo "Done."
