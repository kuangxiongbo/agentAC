export type HumanWatchDecision = 'noop' | 'auto_send' | 'suggest_only' | 'skipped'

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
