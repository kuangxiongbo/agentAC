import { DEFAULT_HUMAN_WATCH_RULE_CONFIG, type HumanWatchRuleConfig } from './human-watch-rules'

export const DEFAULT_INTERVENTION_PROMPT =
  '任务似乎已停滞。请继续下一步，或在受阻时简要说明需要确认的内容。'

export const DEFAULT_INTERVENTION_PROMPT_EN =
  'The task appears stalled. Please continue with the next step, or ask a brief clarifying question if you are blocked.'

export const MAX_INTERVENTIONS_PER_HOUR_DEFAULT = 6
export const DEFAULT_GRACE_AFTER_PROMPT_SECONDS = 30

/** 租户级全局值守判断规则默认值（所有 Worker 绑定共用） */
export function buildDefaultGlobalRules(): Record<string, unknown> {
  return {
    ...DEFAULT_HUMAN_WATCH_RULE_CONFIG,
    grace_after_prompt_seconds: DEFAULT_GRACE_AFTER_PROMPT_SECONDS,
    max_interventions_per_hour: MAX_INTERVENTIONS_PER_HOUR_DEFAULT,
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
    ...rules
  } = raw
  return rules as HumanWatchRuleConfig & Record<string, unknown>
}
