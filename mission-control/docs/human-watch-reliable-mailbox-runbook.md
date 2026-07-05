# Human-Watch Reliable Mailbox Runbook

## Scope

This runbook covers the reliable mailbox path used by human-watch assist, remote session continue, and permission decision relay.

## Feature Switch

- `MC_RELIABLE_EDGE_MESSAGES=1` enables reliable queue fallback for human-watch assist.
- When the switch is unset, prompt-only assist keeps the legacy 2.1.18 synchronous Bridge RPC behavior unless the caller explicitly sends `delivery_mode=auto|queue` or `queue_if_offline=true`.

## Triage

1. Check center backlog:
   - Human-watch page: Reliable Message Queue section.
   - API: `GET /api/edge/messages?status=pending`
   - API: `GET /api/edge/messages?status=failed_retryable`
   - API: `GET /api/edge/messages?status=dead_letter`
2. Check local mailbox:
   - Local Web: `GET http://127.0.0.1:5101/api/local/mailbox/status`
   - Tray menu: `消息队列状态…`
3. Force local drain:
   - Local Web: `POST http://127.0.0.1:5101/api/local/mailbox/drain`
   - Tray menu: `立即处理消息队列`

## Expected Flow

1. Center creates an `edge_messages` row with `type=human_watch.assist.requested`.
2. Bridge sends `edge_message_wakeup` when connected.
3. Local Web leases the message into `local_message_inbox`.
4. Local handler calls the steward judge and enqueues the reply into the Worker session.
5. Local outbox posts ack/fail back to center.

## Failure Notes

- `pending`: Edge has not leased the message yet. Check Bridge connection and local tray runtime.
- `leased`: Edge picked the message but has not acked/fail-returned yet. Check local mailbox status.
- `failed_retryable`: handler or network failed and will retry.
- `dead_letter`: retry budget exhausted; inspect `last_error_message`, then cancel/recreate after fixing the local runtime or binding.
- Duplicate idempotency keys should not duplicate Worker writes; local `local_message_executions` stores completed idempotency keys.
