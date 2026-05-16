import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { config } from '@/lib/config'
import { mutationLimiter } from '@/lib/rate-limit'
import { validateBody, updateSettingsSchema } from '@/lib/validation'
import { restartRemoteBridge } from '@/lib/remote-server-bridge'

interface SettingRow {
  key: string
  value: string
  description: string | null
  category: string
  updated_by: string | null
  updated_at: number
}

type SettingLocale = 'en' | 'zh'
type LocalizedText = Record<SettingLocale, string>

function localized(en: string, zh: string): LocalizedText {
  return { en, zh }
}

function getRequestLocale(request: NextRequest): SettingLocale {
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value?.toLowerCase() || ''
  if (cookieLocale.startsWith('zh')) return 'zh'
  const acceptLang = request.headers.get('accept-language') || ''
  return /\bzh\b/i.test(acceptLang) ? 'zh' : 'en'
}

// Default settings definitions (category, localized description, default value)
const settingDefinitions: Record<string, { category: string; description: LocalizedText; default: string }> = {
  // Retention
  'retention.activities_days': { category: 'retention', description: localized('Days to keep activity records', '活动记录保留天数'), default: String(config.retention.activities) },
  'retention.audit_log_days': { category: 'retention', description: localized('Days to keep audit log entries', '审计日志保留天数'), default: String(config.retention.auditLog) },
  'retention.logs_days': { category: 'retention', description: localized('Days to keep log files', '日志文件保留天数'), default: String(config.retention.logs) },
  'retention.notifications_days': { category: 'retention', description: localized('Days to keep notifications', '通知保留天数'), default: String(config.retention.notifications) },
  'retention.pipeline_runs_days': { category: 'retention', description: localized('Days to keep pipeline run history', '流水线运行历史保留天数'), default: String(config.retention.pipelineRuns) },
  'retention.token_usage_days': { category: 'retention', description: localized('Days to keep token usage data', '令牌用量数据保留天数'), default: String(config.retention.tokenUsage) },
  'retention.gateway_sessions_days': { category: 'retention', description: localized('Days to keep inactive gateway session metadata', '非活跃网关会话元数据保留天数'), default: String(config.retention.gatewaySessions) },

  // Gateway
  'gateway.host': { category: 'gateway', description: localized('Gateway hostname', '网关主机名'), default: config.gatewayHost },
  'gateway.port': { category: 'gateway', description: localized('Gateway port number', '网关端口号'), default: String(config.gatewayPort) },
  'gateway.server_url': { category: 'gateway', description: localized('Remote E-Agent-Center server HTTP base URL for sync (e.g. http://localhost:5000)', '用于同步的远程 E-Agent-Center 服务 HTTP 基址（例如 http://localhost:5000）'), default: '' },
  'gateway.client_name': { category: 'gateway', description: localized('Client name used when syncing this node upstream', '此节点向上游同步时使用的客户端名称'), default: 'E-Agent-Center' },
  'gateway.token': { category: 'gateway', description: localized('API key used for upstream E-Agent-Center sync', '用于上游 E-Agent-Center 同步的 API 密钥'), default: '' },

  // Chat
  'chat.coordinator_target_agent': {
    category: 'chat',
    description: localized(
      'Optional coordinator routing target (agent name or openclawId). When set, coordinator inbox messages are forwarded to this agent before default/main-session fallback.',
      '可选的协调器路由目标（agent 名称或 openclawId）。设置后，协调器收件箱消息会优先转发给该智能体，再回退到默认或主会话。'
    ),
    default: '',
  },

  // General
  'general.site_name': { category: 'general', description: localized('E-Agent-Center display name', 'E-Agent-Center 显示名称'), default: 'E-Agent-Center' },
  'general.auto_cleanup': { category: 'general', description: localized('Enable automatic data cleanup', '启用自动数据清理'), default: 'false' },
  'general.auto_backup': { category: 'general', description: localized('Enable automatic daily backups', '启用每日自动备份'), default: 'false' },
  'general.backup_retention_count': { category: 'general', description: localized('Number of backup files to keep', '保留的备份文件数量'), default: '10' },
  'general.server_gateway_sync': { category: 'general', description: localized('Enable periodic upstream E-Agent-Center sync', '启用周期性的上游 E-Agent-Center 同步'), default: 'true' },

  // Subscription overrides
  'subscription.plan_override': { category: 'general', description: localized('Override auto-detected subscription plan (e.g. max, max_5x, pro)', '覆盖自动检测到的订阅计划（例如 max、max_5x、pro）'), default: '' },
  'subscription.codex_plan': { category: 'general', description: localized('Codex/OpenAI subscription plan (e.g. chatgpt, plus, pro)', 'Codex/OpenAI 订阅计划（例如 chatgpt、plus、pro）'), default: '' },

  // Interface
  'general.interface_mode': { category: 'general', description: localized('Interface complexity (essential or full)', '界面复杂度（精简或完整）'), default: 'essential' },

  // Onboarding
  'onboarding.completed': { category: 'onboarding', description: localized('Whether onboarding has been completed', '引导是否已完成'), default: 'false' },
  'onboarding.completed_at': { category: 'onboarding', description: localized('Timestamp when onboarding was completed', '引导完成时间戳'), default: '' },
  'onboarding.skipped': { category: 'onboarding', description: localized('Whether onboarding was skipped', '是否已跳过引导'), default: 'false' },
  'onboarding.completed_steps': { category: 'onboarding', description: localized('JSON array of completed step IDs', '已完成步骤 ID 的 JSON 数组'), default: '[]' },
  'onboarding.checklist_dismissed': { category: 'onboarding', description: localized('Whether the onboarding checklist has been dismissed', '引导清单是否已关闭'), default: 'false' },
}

/**
 * GET /api/settings - List all settings (grouped by category)
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const locale = getRequestLocale(request)

  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM settings ORDER BY category, key').all() as SettingRow[]
  const stored = new Map(rows.map(r => [r.key, r]))

  // Merge defaults with stored values
  const settings: Array<{
    key: string
    value: string
    description: string
    category: string
    updated_by: string | null
    updated_at: number | null
    is_default: boolean
  }> = []

  for (const [key, def] of Object.entries(settingDefinitions)) {
    const row = stored.get(key)
    settings.push({
      key,
      value: row?.value ?? def.default,
      description: def.description[locale],
      category: row?.category ?? def.category,
      updated_by: row?.updated_by ?? null,
      updated_at: row?.updated_at ?? null,
      is_default: !row,
    })
  }

  // Also include any custom settings not in definitions
  for (const row of rows) {
    if (!settingDefinitions[row.key]) {
      settings.push({
        key: row.key,
        value: row.value,
        description: row.description ?? '',
        category: row.category,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
        is_default: false,
      })
    }
  }

  // Group by category
  const grouped: Record<string, typeof settings> = {}
  for (const s of settings) {
    if (!grouped[s.category]) grouped[s.category] = []
    grouped[s.category].push(s)
  }

  return NextResponse.json({ settings, grouped })
}

/**
 * PUT /api/settings - Update one or more settings
 * Body: { settings: { key: value, ... } }
 */
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const result = await validateBody(request, updateSettingsSchema)
  if ('error' in result) return result.error
  const body = result.data

  const db = getDatabase()
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, description, category, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = unixepoch()
  `)

  const updated: string[] = []
  const changes: Record<string, { old: string | null; new: string }> = {}

  const txn = db.transaction(() => {
    for (const [key, value] of Object.entries(body.settings)) {
      const strValue = String(value)
      const def = settingDefinitions[key]
      const category = def?.category ?? 'custom'
      const description = def?.description.en ?? null

      // Get old value for audit
      const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      changes[key] = { old: existing?.value ?? null, new: strValue }

      upsert.run(key, strValue, description, category, auth.user.username)
      updated.push(key)
    }
  })

  txn()

  // Audit log
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  logAuditEvent({
    action: 'settings_update',
    actor: auth.user.username,
    actor_id: auth.user.id,
    detail: { updated_keys: updated, changes },
    ip_address: ipAddress,
  })

  // Trigger bridge restart if gateway settings changed
  const gatewayKeys = ['gateway.server_url', 'gateway.token']
  if (updated.some(key => gatewayKeys.includes(key))) {
    restartRemoteBridge()
  }

  return NextResponse.json({ updated, count: updated.length })
}

/**
 * DELETE /api/settings?key=... - Reset a setting to default
 */
export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body required' }, { status: 400 }) }
  const key = body.key

  if (!key) {
    return NextResponse.json({ error: 'key parameter required' }, { status: 400 })
  }

  const db = getDatabase()
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined

  if (!existing) {
    return NextResponse.json({ error: 'Setting not found or already at default' }, { status: 404 })
  }

  db.prepare('DELETE FROM settings WHERE key = ?').run(key)

  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'
  logAuditEvent({
    action: 'settings_reset',
    actor: auth.user.username,
    actor_id: auth.user.id,
    detail: { key, old_value: existing.value },
    ip_address: ipAddress,
  })

  return NextResponse.json({ reset: key, default_value: settingDefinitions[key]?.default ?? null })
}
