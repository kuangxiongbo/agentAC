import { getAgentLocalSessionKind } from './agent-session-binding'
import { isBridgeClientOnline } from './bridge-server'
import { listHumanWatchInterventions } from './human-watch-audit'
import { getHumanWatchBinding, type HumanWatchBindingRow } from './human-watch-bindings'
import { isHumanWatchEnabledForTenant } from './human-watch-policy'
import { resolveHumanWatchRulesForBinding } from './human-watch-global-rules'
import { evaluateHumanWatchRules } from './human-watch-rules'
import { transcriptMessagesToHumanWatchLines } from './human-watch-transcript'
import { requestBridgeClientSessionTranscript } from './bridge-server'
import { getBridgeAgentIndexByLocalId } from './sync-agent-index'
import type { LocalSessionTranscriptKind } from './session-transcript'

const RULES_LOOKBACK = 12

export type HumanWatchDiagnoseCheck = {
  id: string
  ok: boolean
  detail?: string
  value?: unknown
}

export type HumanWatchDiagnoseResult = {
  binding_id: number
  checks: HumanWatchDiagnoseCheck[]
  rule_config: Record<string, unknown>
  evaluation: ReturnType<typeof evaluateHumanWatchRules> | null
  transcript_line_count: number
  recent_interventions: ReturnType<typeof listHumanWatchInterventions>
  hints: string[]
}

function resolveSessionKind(binding: HumanWatchBindingRow): LocalSessionTranscriptKind | null {
  const storedKind = binding.worker_session_kind
  if (storedKind === 'claude-code' || storedKind === 'codex-cli' || storedKind === 'hermes') return storedKind
  const indexRow = binding.worker_local_agent_id
    ? getBridgeAgentIndexByLocalId(binding.client_id, binding.worker_local_agent_id)
    : undefined
  const kind = getAgentLocalSessionKind(indexRow?.framework)
  if (kind === 'claude-code' || kind === 'codex-cli' || kind === 'hermes') return kind
  return null
}

/** Dry-run checklist for why human-watch did or did not intervene. */
export async function diagnoseHumanWatchBinding(
  bindingId: number,
  workspaceId: number,
): Promise<HumanWatchDiagnoseResult | null> {
  const binding = getHumanWatchBinding(bindingId, workspaceId)
  if (!binding) return null

  const hints: string[] = []
  const checks: HumanWatchDiagnoseCheck[] = []
  const tenantId = binding.tenant_id ?? 1

  checks.push({
    id: 'binding_enabled',
    ok: Boolean(binding.enabled),
    detail: binding.enabled ? '绑定已启用' : '绑定未启用',
  })
  checks.push({
    id: 'tenant_policy',
    ok: isHumanWatchEnabledForTenant(tenantId),
    detail: isHumanWatchEnabledForTenant(tenantId)
      ? '租户已开通人工值守'
      : '租户未开通人工值守（tenants.human_watch_enabled 或订阅权益）',
  })
  const bridgeOnline = isBridgeClientOnline(binding.client_id)
  checks.push({
    id: 'bridge_online',
    ok: bridgeOnline,
    detail: bridgeOnline ? `Bridge 在线 (${binding.client_id})` : `Bridge 离线 (${binding.client_id})`,
  })

  const sessionId = String(binding.worker_session_id || '').trim()
  checks.push({
    id: 'worker_session_id',
    ok: Boolean(sessionId),
    value: sessionId || null,
    detail: sessionId ? '已配置 worker_session_id' : '缺少 worker_session_id，编排无法拉 transcript',
  })

  const indexRow =
    binding.worker_local_agent_id != null
      ? getBridgeAgentIndexByLocalId(binding.client_id, binding.worker_local_agent_id)
      : undefined
  const indexSession = String(indexRow?.session_key || '').trim()
  checks.push({
    id: 'index_session_key',
    ok: Boolean(indexSession),
    value: indexSession || null,
    detail: indexSession
      ? `Bridge 索引 session_key=${indexSession}`
      : '索引无 session_key（Worker 可能未绑定会话）',
  })
  if (sessionId && indexSession && sessionId !== indexSession) {
    checks.push({
      id: 'session_id_aligned',
      ok: false,
      detail: `绑定 session (${sessionId}) 与索引 session_key (${indexSession}) 不一致；60s 轮询可能用旧 id，transcript 事件可能匹配失败`,
    })
    hints.push('在 Worker 详情重新保存人工值守绑定，或等待 Bridge 同步后 syncHumanWatchBindingSessionIds 对齐')
  } else if (sessionId && indexSession) {
    checks.push({ id: 'session_id_aligned', ok: true, detail: '绑定 session 与索引一致' })
  }

  checks.push({
    id: 'mode_auto_send',
    ok: binding.mode === 'auto_send',
    value: binding.mode,
    detail:
      binding.mode === 'auto_send'
        ? '模式为 auto_send，命中后会注入 Worker 会话'
        : `模式为 ${binding.mode}，命中后仅记录 suggest_only，不会代发`,
  })

  checks.push({
    id: 'steward_bound',
    ok: binding.steward_local_agent_id != null,
    value: binding.steward_local_agent_id,
    detail: binding.steward_local_agent_id
      ? `已绑定值守 Agent (local ${binding.steward_local_agent_id})`
      : '未绑定值守 Agent，命中后无法判官生成话术',
  })

  const sessionKind = resolveSessionKind(binding)
  checks.push({
    id: 'session_kind',
    ok: Boolean(sessionKind),
    value: sessionKind,
    detail: sessionKind
      ? `stored=${binding.worker_session_kind ?? '(空)'}, framework=${indexRow?.framework ?? '?'} → ${sessionKind}`
      : `framework=${indexRow?.framework ?? '(空)'} 无法映射会话类型`,
  })

  const ruleConfig = resolveHumanWatchRulesForBinding(binding)
  let evaluation: ReturnType<typeof evaluateHumanWatchRules> | null = null
  let transcriptLineCount = 0

  if (bridgeOnline && sessionId && sessionKind) {
    try {
      const page = await requestBridgeClientSessionTranscript({
        clientId: binding.client_id,
        kind: sessionKind,
        sessionId,
        limit: 80,
      })
      const lines = transcriptMessagesToHumanWatchLines(page.messages).slice(-RULES_LOOKBACK)
      transcriptLineCount = lines.length
      evaluation = evaluateHumanWatchRules(lines, ruleConfig)
      checks.push({
        id: 'rules_matched',
        ok: evaluation.matched,
        value: evaluation.rulesHit,
        detail: evaluation.matched
          ? '当前 transcript 满足介入规则'
          : `未满足规则: ${evaluation.reason ?? 'no_rule_match'}（默认：强确认/工具受阻 idle≥${ruleConfig.idle_timeout_with_stuck_seconds ?? 30}s，且最后一条须为 assistant 未回复）`,
      })
      if (!evaluation.matched && evaluation.rulesHit.idle_timeout && !evaluation.rulesHit.confirmation_text) {
        hints.push('助手已空闲足够久，但最后几条回复未命中确认类关键词；可放宽 confirmation_patterns 或调低 idle_timeout_seconds')
      }
      if (!evaluation.matched && evaluation.rulesHit.confirmation_text && !evaluation.rulesHit.idle_timeout) {
        hints.push('已检测到确认/受阻话术，但距最后一条消息未满 idle 秒数；请等待后再观察或调低 idle_timeout_seconds')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      checks.push({
        id: 'transcript_fetch',
        ok: false,
        detail: `拉取边缘 transcript 失败: ${message}`,
      })
      hints.push('确认边缘 client 已连接 Bridge，且 worker_session_id 为当前 Codex/Claude 会话 id')
    }
  }

  const recent = listHumanWatchInterventions({
    workspaceId,
    bindingId,
    limit: 15,
  })

  if (recent.length === 0) {
    hints.push('尚无审计记录：可能编排未启动、会话 id 未匹配、或边缘未上报 session_transcript_changed（需更新 mission-control-client）')
  } else {
    const last = recent[0]
    if (last?.event_type === 'rule_evaluated' && last.skip_reason === 'no_rule_match') {
      hints.push(`最近一次评估: no_rule_match（见 rules_hit）`)
    }
    if (last?.skip_reason === 'bridge_offline') {
      hints.push('最近一次因 Bridge 离线跳过')
    }
  }

  return {
    binding_id: bindingId,
    checks,
    rule_config: ruleConfig as Record<string, unknown>,
    evaluation,
    transcript_line_count: transcriptLineCount,
    recent_interventions: recent,
    hints,
  }
}
