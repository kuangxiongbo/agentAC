import { DEFAULT_HUMAN_WATCH_RULE_CONFIG, type HumanWatchRuleConfig } from './human-watch-rules'

export const DEFAULT_INTERVENTION_PROMPT =
  '任务似乎需要继续确认或回复。请结合上下文给出明确回复，帮助 Worker 继续推进。'

export const DEFAULT_INTERVENTION_PROMPT_EN =
  'The task appears to need a confirmation or reply. Respond clearly from the context so the Worker can continue.'

export const MAX_INTERVENTIONS_PER_WINDOW_DEFAULT = 60
export const DEFAULT_INTERVENTION_RATE_WINDOW_SECONDS = 24 * 60 * 60
export const DEFAULT_GRACE_AFTER_PROMPT_SECONDS = 0

/** 租户级全局值守判断规则默认值（所有 Worker 绑定共用） */
export function buildDefaultGlobalRules(): Record<string, unknown> {
  return {
    ...DEFAULT_HUMAN_WATCH_RULE_CONFIG,
    grace_after_prompt_seconds: DEFAULT_GRACE_AFTER_PROMPT_SECONDS,
    max_interventions_per_hour: MAX_INTERVENTIONS_PER_WINDOW_DEFAULT,
    max_interventions_window_seconds: DEFAULT_INTERVENTION_RATE_WINDOW_SECONDS,
  }
}

/** @deprecated 使用 buildDefaultGlobalRules；保留兼容旧引用 */
export function buildDefaultBindingRulesOverride(): Record<string, unknown> {
  return {
    ...buildDefaultGlobalRules(),
    prompt_template: DEFAULT_INTERVENTION_PROMPT,
  }
}

export function buildDefaultStewardAgentConfig(): Record<string, unknown> {
  const bindingDefaults = buildDefaultGlobalRules()
  return {
    agent_kind: 'human_watch',
    steward: {
      context: {
        rule_max_messages: 12,
        rule_max_chars: 32000,
        judge_max_messages: 24,
        judge_max_chars: 32000,
      },
      fingerprint_dedupe: true,
      llm_enabled: true,
      llm_sweep_enabled: false,
      llm_sweep_interval_minutes: 30,
      /** 与 binding.rules_override 对齐，便于在智能体 config 中查看默认规则 */
      rules: stripBindingOnlyFields(bindingDefaults),
      binding_defaults: bindingDefaults,
    },
  }
}

function stripBindingOnlyFields(
  raw: Record<string, unknown>,
): HumanWatchRuleConfig & Record<string, unknown> {
  const {
    prompt_template: _p,
    grace_after_prompt_seconds: _g,
    max_interventions_per_hour: _m,
    max_interventions_window_seconds: _w,
    ...rules
  } = raw
  return rules as HumanWatchRuleConfig & Record<string, unknown>
}
