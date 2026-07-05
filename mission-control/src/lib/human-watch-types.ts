export type HumanWatchDecision = 'noop' | 'auto_send' | 'suggest_only' | 'skipped'

export type HumanWatchEventSource =
  | 'worker_tool'
  | 'permission_request'
  | 'transcript_rule'
  | 'transcript_wait'
  | 'system'

export type HumanWatchEventStatus =
  | 'pending'
  | 'visible'
  | 'claimed'
  | 'resolved'
  | 'dismissed'
  | 'expired'

export type HumanWatchEventAction =
  | 'send_message_to_worker'
  | 'approve_request'
  | 'deny_request'
  | 'dismiss'

export type HumanWatchEventPriority = 'low' | 'medium' | 'high' | 'critical'

export type HumanWatchInterventionEventType =
  | 'rule_evaluated'
  | 'intervention_attempt'
  | 'intervention_completed'
  | 'intervention_skipped'
  | 'llm_sweep'

export type HumanWatchInterventionOutcome = 'success' | 'failed' | 'skipped'

export type HumanWatchBindingMode = 'auto_send' | 'suggest_only'

export interface HumanWatchRulesHit {
  idle_timeout?: boolean
  pending_tool?: boolean
  confirmation_text?: boolean
  awaiting_user_response?: boolean
  [key: string]: unknown
}

export interface LogHumanWatchInterventionInput {
  workspaceId: number
  tenantId?: number | null
  clientId: string
  bindingId?: number | null
  workerSyncIndexId?: number | null
  workerLocalAgentId?: number | null
  workerName?: string | null
  stewardSyncIndexId?: number | null
  stewardLocalAgentId?: number | null
  stewardName?: string | null
  workerSessionId?: string | null
  eventType: HumanWatchInterventionEventType
  decision?: HumanWatchDecision | null
  rulesHit?: HumanWatchRulesHit | null
  fingerprint?: string | null
  promptPreview?: string | null
  promptSha256?: string | null
  outcome?: HumanWatchInterventionOutcome | null
  errorMessage?: string | null
  bridgeRequestId?: string | null
  llmSweep?: boolean
  skipReason?: string | null
}

export interface HumanWatchInterventionRow {
  id: number
  workspace_id: number
  tenant_id: number | null
  client_id: string
  binding_id: number | null
  worker_sync_index_id: number | null
  worker_local_agent_id: number | null
  worker_name: string | null
  steward_sync_index_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  worker_session_id: string | null
  event_type: HumanWatchInterventionEventType
  decision: HumanWatchDecision | null
  rules_hit: string | null
  fingerprint: string | null
  prompt_preview: string | null
  prompt_sha256: string | null
  outcome: HumanWatchInterventionOutcome | null
  error_message: string | null
  bridge_request_id: string | null
  llm_sweep: number
  skip_reason: string | null
  created_at: number
}

export interface ListHumanWatchInterventionsFilters {
  workspaceId: number
  tenantId?: number
  clientId?: string
  bindingId?: number
  workerSyncIndexId?: number
  workerLocalAgentId?: number
  stewardSyncIndexId?: number
  stewardLocalAgentId?: number
  since?: number
  limit?: number
}

export interface HumanWatchEventRow {
  id: string
  workspace_id: number
  tenant_id: number | null
  client_id: string
  binding_id: number | null
  worker_sync_index_id: number | null
  worker_local_agent_id: number | null
  worker_name: string | null
  worker_session_id: string | null
  steward_sync_index_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  permission_request_id: string | null
  source: HumanWatchEventSource
  status: HumanWatchEventStatus
  priority: HumanWatchEventPriority
  title: string
  summary: string
  context_json: string | null
  latest_worker_message: string | null
  suggested_action: HumanWatchEventAction | null
  claimed_by_type: 'human_user' | 'human_external' | 'steward_agent' | 'system' | null
  claimed_by_user_id: number | null
  claimed_by_agent_id: string | null
  claimed_at: number | null
  resolved_action: HumanWatchEventAction | null
  resolved_note: string | null
  resolved_by_type: 'human_user' | 'human_external' | 'steward_agent' | 'system' | null
  resolved_by_user_id: number | null
  resolved_by_agent_id: string | null
  resolved_at: number | null
  dedupe_key: string | null
  created_at: number
  updated_at: number
}

export interface HumanWatchEventView extends Omit<HumanWatchEventRow, 'context_json'> {
  context: Record<string, unknown> | null
}

export interface ListHumanWatchEventsFilters {
  workspaceId: number
  tenantId?: number
  clientId?: string
  bindingId?: number
  workerLocalAgentId?: number
  stewardLocalAgentId?: number
  workerSessionId?: string
  permissionRequestId?: string
  source?: HumanWatchEventSource
  status?: HumanWatchEventStatus
  limit?: number
}
