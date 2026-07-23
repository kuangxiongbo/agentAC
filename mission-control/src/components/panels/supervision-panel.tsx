'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { SessionMessage, shouldShowTimestamp, type SessionTranscriptMessage } from '@/components/chat/session-message'
import { useAgentCenterStore } from '@/store'

interface Goal {
  id: string
  client_id: string
  steward_local_agent_id: number
  title: string
  objective: string
  success_criteria: Array<{ id: string; text: string; evidence_type?: string }>
  constraints: string[]
  status: string
  priority: string
  budget: Record<string, number>
  usage: Record<string, number>
  current_plan_version: number
  requires_plan_approval: boolean
  version: number
  created_at: number
  updated_at: number
}

interface GoalTask {
  task_id: number
  plan_version: number
  logical_task_key: string
  title: string
  status: string
  assigned_to: string | null
  assigned_agent_id: string | null
  assigned_session_id: string | null
  client_id: string
  session_kind: 'claude-code' | 'codex-cli' | 'hermes' | null
  retry_count: number
  reassignment_count: number
  outcome: string | null
  resolution: string | null
  error_message: string | null
  updated_at: number
}

interface GoalPlan {
  id: string
  version: number
  status: string
  rationale: string | null
  plan: {
    summary: string
    tasks: Array<{ logical_key: string; title: string; risk: string; dependencies: string[] }>
  }
}

interface GoalEvent {
  id: number
  event_type: string
  decision: string | null
  reason: string | null
  created_at: number
}

interface Binding {
  id: number
  client_id: string
  steward_local_agent_id: number | null
  steward_name: string | null
  enabled: boolean
}

interface Memory {
  id: string
  category: string
  scope_type: string
  scope_id: string
  content: string
  summary: string | null
  confidence: number
  status: string
  source_refs: string[]
  updated_at: number
}

const STATUS_STYLE: Record<string, string> = {
  planning: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',
  awaiting_plan_approval: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  running: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  blocked: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  verifying: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  completed: 'text-green-300 bg-green-500/10 border-green-500/30',
  failed: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  cancelled: 'text-muted-foreground bg-muted/30 border-border',
}

function StatusBadge({ value }: { value: string }) {
  return <span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] ${STATUS_STYLE[value] || 'text-muted-foreground border-border'}`}>{value}</span>
}

function dateTime(timestamp: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : '-'
}

const TASK_STATUS_LABELS: Record<string, string> = {
  inbox: '等待依赖/分派',
  assigned: '已分派',
  in_progress: '执行中',
  review: '待审核',
  quality_review: '质量审核',
  done: '已完成',
  failed: '执行失败',
}

function taskStatus(task: GoalTask): { label: string; stale: boolean } {
  const stale = task.status === 'in_progress' && Date.now() / 1000 - task.updated_at > 300
  return { label: stale ? '长时间无进展' : TASK_STATUS_LABELS[task.status] || task.status, stale }
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

export function SupervisionPanel() {
  const { centralMode } = useAgentCenterStore()
  const [view, setView] = useState<'goals' | 'memories'>('goals')
  if (!centralMode) return <div className="p-6 text-sm text-muted-foreground">目标监督仅在服务端模式可用。</div>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 md:px-6">
        <div>
          <h1 className="text-base font-semibold text-foreground">值守目标监督</h1>
          <p className="text-xs text-muted-foreground">目标、任务、纠偏、验收与受控记忆</p>
        </div>
        <div className="flex rounded-md border border-border bg-surface-1 p-0.5">
          <button className={`h-7 px-3 text-xs ${view === 'goals' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`} onClick={() => setView('goals')}>目标</button>
          <button className={`h-7 px-3 text-xs ${view === 'memories' ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`} onClick={() => setView('memories')}>记忆</button>
        </div>
      </div>
      {view === 'goals' ? <GoalsWorkspace /> : <MemoryWorkspace />}
    </div>
  )
}

function GoalsWorkspace() {
  const [goals, setGoals] = useState<Goal[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const data = await api('/api/supervision/goals?limit=100')
      const rows = Array.isArray(data.goals) ? data.goals : []
      setGoals(rows)
      setSelectedId((current) => current && rows.some((goal: Goal) => goal.id === current) ? current : rows[0]?.id || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  if (loading) return <Loader variant="panel" label="加载目标" />

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 border-b border-border md:border-b-0 md:border-r">
        <div className="flex h-12 items-center justify-between border-b border-border px-3">
          <span className="text-xs font-medium text-muted-foreground">{goals.length} 个目标</span>
          <Button size="xs" onClick={() => setCreateOpen(true)}>新建目标</Button>
        </div>
        <div className="max-h-[34vh] overflow-y-auto p-2 md:max-h-none md:h-[calc(100%-3rem)]">
          {goals.map((goal) => (
            <button
              key={goal.id}
              onClick={() => setSelectedId(goal.id)}
              className={`mb-1 w-full border-l-2 px-3 py-2 text-left ${selectedId === goal.id ? 'border-primary bg-secondary/70' : 'border-transparent hover:bg-secondary/40'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-sm font-medium text-foreground">{goal.title}</span>
                <StatusBadge value={goal.status} />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{goal.priority}</span><span>{dateTime(goal.updated_at)}</span>
              </div>
            </button>
          ))}
          {goals.length === 0 ? <p className="px-3 py-8 text-center text-xs text-muted-foreground">暂无目标</p> : null}
          {error ? <p className="px-3 py-2 text-xs text-rose-400">{error}</p> : null}
        </div>
      </aside>
      <main className="min-h-0 overflow-y-auto">
        {selectedId ? <GoalDetail goalId={selectedId} onChanged={load} /> : <div className="p-8 text-sm text-muted-foreground">选择或创建目标。</div>}
      </main>
      {createOpen ? <CreateGoalDialog onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); await load() }} /> : null}
    </div>
  )
}

function GoalDetail({ goalId, onChanged }: { goalId: string; onChanged: () => Promise<void> }) {
  const [goal, setGoal] = useState<Goal | null>(null)
  const [tasks, setTasks] = useState<GoalTask[]>([])
  const [events, setEvents] = useState<GoalEvent[]>([])
  const [plans, setPlans] = useState<GoalPlan[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processTask, setProcessTask] = useState<GoalTask | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [detail, planData] = await Promise.all([
        api(`/api/supervision/goals/${goalId}`),
        api(`/api/supervision/goals/${goalId}/plan`),
      ])
      setGoal(detail.goal)
      setTasks(Array.isArray(detail.tasks) ? detail.tasks : [])
      setEvents(Array.isArray(detail.events) ? detail.events.slice().reverse() : [])
      setPlans(Array.isArray(planData.plans) ? planData.plans : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    }
  }, [goalId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (goal?.status !== 'running') return
    const timer = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(timer)
  }, [goal?.status, load])

  const act = async (name: string, request: () => Promise<unknown>) => {
    setBusy(name); setError(null)
    try { await request(); await load(); await onChanged() } catch (err) { setError(err instanceof Error ? err.message : '操作失败') } finally { setBusy(null) }
  }

  if (!goal) return <Loader variant="panel" label="加载目标详情" />
  const currentPlan = plans.find((plan) => plan.version === goal.current_plan_version) || plans[0]
  const activeTasks = tasks.filter((task) => task.plan_version === goal.current_plan_version)
  const modelCalls = Number(goal.usage.model_calls || 0)

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <header className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge value={goal.status} /><span className="text-xs text-muted-foreground">{goal.priority}</span></div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">{goal.title}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{goal.objective}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {goal.status === 'planning' ? <Button size="sm" disabled={busy !== null} onClick={() => act('plan', () => api(`/api/supervision/goals/${goal.id}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'generate' }) }))}>{busy === 'plan' ? '生成中' : '生成计划'}</Button> : null}
          {goal.status === 'awaiting_plan_approval' && currentPlan ? <Button size="sm" variant="success" disabled={busy !== null} onClick={() => act('approve', () => api(`/api/supervision/goals/${goal.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve_plan', version: goal.version, plan_version: currentPlan.version }) }))}>批准计划</Button> : null}
          {goal.status === 'running' ? <Button size="sm" disabled={busy !== null} onClick={() => act('dispatch', () => api(`/api/supervision/goals/${goal.id}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))}>分派任务</Button> : null}
          {['running', 'blocked', 'verifying'].includes(goal.status) ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('pause', () => api(`/api/supervision/goals/${goal.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: goal.status === 'blocked' ? 'resume' : 'pause', version: goal.version }) }))}>{goal.status === 'blocked' ? '恢复' : '暂停'}</Button> : null}
        </div>
      </header>

      {error ? <div className="border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</div> : null}

      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4">
        <Metric label="计划版本" value={String(goal.current_plan_version)} />
        <Metric label="任务" value={`${activeTasks.filter((task) => task.status === 'done').length}/${activeTasks.length}`} />
        <Metric label="模型调用" value={`${modelCalls}/${goal.budget.max_model_calls || '-'}`} />
        <Metric label="重规划" value={`${Number(goal.usage.replans || 0)}/${goal.budget.max_replans || 0}`} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-foreground">成功标准</h3>
        <div className="divide-y divide-border border-y border-border">
          {goal.success_criteria.map((criterion) => <div key={criterion.id} className="flex gap-3 py-2 text-sm"><span className="font-mono text-xs text-muted-foreground">{criterion.id}</span><span>{criterion.text}</span><span className="ml-auto text-xs text-muted-foreground">{criterion.evidence_type || 'review'}</span></div>)}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">当前计划</h3>{currentPlan ? <StatusBadge value={currentPlan.status} /> : null}</div>
        {currentPlan ? <div className="border-y border-border py-3"><p className="text-sm text-muted-foreground">{currentPlan.plan.summary}</p><div className="mt-3 grid gap-2 md:grid-cols-2">{currentPlan.plan.tasks.map((task) => <div key={task.logical_key} className="border-l-2 border-border pl-3"><div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{task.title}</span><span className="text-[10px] text-muted-foreground">{task.risk}</span></div><p className="text-[10px] text-muted-foreground">{task.logical_key}{task.dependencies.length ? ` ← ${task.dependencies.join(', ')}` : ''}</p></div>)}</div></div> : <p className="text-xs text-muted-foreground">尚未生成计划</p>}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">任务执行</h3>
        <div className="overflow-x-auto border-y border-border">
          <table className="w-full min-w-[820px] text-left text-xs"><thead className="text-muted-foreground"><tr><th className="py-2 pr-3">任务</th><th className="py-2 pr-3">状态</th><th className="py-2 pr-3">Worker</th><th className="py-2 pr-3">最后变化</th><th className="py-2 pr-3">重试/换人</th><th className="py-2 pr-3">结果</th><th className="py-2">过程</th></tr></thead><tbody className="divide-y divide-border">{activeTasks.map((task) => {
            const display = taskStatus(task)
            return <tr key={task.task_id}><td className="py-2 pr-3"><span className="font-medium">#{task.task_id} {task.title}</span><div className="font-mono text-[10px] text-muted-foreground">{task.logical_task_key}</div></td><td className="py-2 pr-3"><span className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] ${display.stale ? STATUS_STYLE.failed : STATUS_STYLE[task.status] || 'text-muted-foreground border-border'}`}>{display.label}</span></td><td className="py-2 pr-3 text-muted-foreground">{task.assigned_to || '-'}</td><td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{dateTime(task.updated_at)}</td><td className="py-2 pr-3">{task.retry_count}/{task.reassignment_count}</td><td className="max-w-xs truncate py-2 pr-3 text-muted-foreground">{task.error_message || task.resolution || task.outcome || '-'}</td><td className="py-2">{task.assigned_session_id ? <Button size="xs" variant="outline" onClick={() => setProcessTask(task)}>查看过程</Button> : <span className="text-muted-foreground">-</span>}</td></tr>
          })}</tbody></table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">监督事件</h3>
        <div className="max-h-80 overflow-y-auto divide-y divide-border border-y border-border">
          {events.map((event) => <div key={event.id} className="grid gap-1 py-2 text-xs md:grid-cols-[170px_150px_1fr]"><span className="text-muted-foreground">{dateTime(event.created_at)}</span><span className="font-mono text-foreground/80">{event.event_type}</span><span className="text-muted-foreground">{event.decision || ''}{event.reason ? ` · ${event.reason}` : ''}</span></div>)}
          {events.length === 0 ? <p className="py-4 text-xs text-muted-foreground">暂无事件</p> : null}
        </div>
      </section>
      {processTask ? <TaskProcessDialog task={processTask} onClose={() => setProcessTask(null)} /> : null}
    </div>
  )
}

function TaskProcessDialog({ task, onClose }: { task: GoalTask; onClose: () => void }) {
  const [messages, setMessages] = useState<SessionTranscriptMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fetchTranscript = useCallback(async () => {
    if (!task.assigned_session_id || !task.session_kind) {
      setError('任务缺少 session_kind，无法读取执行会话。')
      setLoading(false)
      return
    }
    try {
      const params = new URLSearchParams({
        kind: task.session_kind,
        id: task.assigned_session_id,
        client_id: task.client_id,
        limit: '120',
        nocache: '1',
      })
      const response = await fetch(`/api/sessions/transcript?${params}`)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      setMessages(Array.isArray(body.messages) ? body.messages : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取执行过程失败')
    } finally {
      setLoading(false)
    }
  }, [task.assigned_session_id, task.client_id, task.session_kind])

  useEffect(() => { void fetchTranscript() }, [fetchTranscript])
  useEffect(() => {
    if (task.status !== 'in_progress') return
    const timer = window.setInterval(() => void fetchTranscript(), 5000)
    return () => window.clearInterval(timer)
  }, [fetchTranscript, task.status])
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length])

  const latestTimestamp = messages.reduce((latest, message) => {
    const value = message.timestamp ? new Date(message.timestamp).getTime() : 0
    return Math.max(latest, Number.isFinite(value) ? value : 0)
  }, 0)
  const hasCurrentTaskActivity = latestTimestamp >= (task.updated_at - 10) * 1000

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}><div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-md border border-border bg-background shadow-2xl"><header className="flex shrink-0 items-start justify-between border-b border-border px-4 py-3"><div className="min-w-0"><h2 className="truncate text-sm font-semibold">#{task.task_id} {task.title}</h2><p className="mt-1 font-mono text-[10px] text-muted-foreground">{task.session_kind || 'unknown'} · {task.assigned_session_id}</p></div><button className="h-8 w-8 text-xl text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="关闭">×</button></header><div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs"><span className="text-muted-foreground">Worker：{task.assigned_to || '-'} · 任务状态：{taskStatus(task).label}</span><Button size="xs" variant="outline" onClick={() => void fetchTranscript()}>刷新</Button></div>{!loading && !error && !hasCurrentTaskActivity ? <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">该会话中尚未发现本次任务派发后的新记录，任务可能仍在排队或派发失败。</div> : null}{error ? <div className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{error}</div> : null}<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-3">{loading ? <Loader variant="panel" label="加载执行过程" /> : messages.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">暂无会话记录</p> : messages.map((message, index) => <SessionMessage key={`${message.timestamp || 'message'}-${index}`} message={message} showTimestamp={shouldShowTimestamp(message, messages[index - 1])} />)}</div></div></div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-background px-3 py-3"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>
}

function CreateGoalDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [bindings, setBindings] = useState<Binding[]>([])
  const [bindingId, setBindingId] = useState('')
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState('')
  const [constraints, setConstraints] = useState('')
  const [approval, setApproval] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api('/api/human-watch/bindings').then((data) => {
      const rows = (Array.isArray(data.bindings) ? data.bindings : []).filter((binding: Binding) => binding.enabled && binding.steward_local_agent_id)
      setBindings(rows); setBindingId(rows[0] ? String(rows[0].id) : '')
    }).catch((err) => setError(err.message))
  }, [])
  const selected = bindings.find((binding) => String(binding.id) === bindingId)
  const submit = async () => {
    if (!selected) return setError('请选择值守绑定')
    const successCriteria = criteria.split('\n').map((text) => text.trim()).filter(Boolean).map((text, index) => ({ id: `criterion-${index + 1}`, text, evidence_type: 'review' }))
    if (!title.trim() || !objective.trim() || successCriteria.length === 0) return setError('请填写标题、目标描述和成功标准')
    setSaving(true); setError(null)
    try {
      await api('/api/supervision/goals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        client_id: selected.client_id,
        steward_local_agent_id: selected.steward_local_agent_id,
        title: title.trim(), objective: objective.trim(), success_criteria: successCriteria,
        constraints: constraints.split('\n').map((text) => text.trim()).filter(Boolean),
        requires_plan_approval: approval,
      }) })
      await onCreated()
    } catch (err) { setError(err instanceof Error ? err.message : '创建失败') } finally { setSaving(false) }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}><div className="w-full max-w-xl rounded-lg border border-border bg-background shadow-2xl"><div className="flex h-12 items-center justify-between border-b border-border px-4"><h2 className="text-sm font-semibold">新建监督目标</h2><button className="h-8 w-8 text-xl text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="关闭">×</button></div><div className="space-y-4 p-4"><Field label="值守 Agent"><select value={bindingId} onChange={(event) => setBindingId(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"><option value="">选择绑定</option>{bindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.steward_name || binding.steward_local_agent_id} · {binding.client_id}</option>)}</select></Field><Field label="标题"><input value={title} onChange={(event) => setTitle(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm" /></Field><Field label="目标描述"><textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></Field><Field label="成功标准（每行一条）"><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} rows={3} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></Field><Field label="约束（每行一条）"><textarea value={constraints} onChange={(event) => setConstraints(event.target.value)} rows={2} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></Field><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={approval} onChange={(event) => setApproval(event.target.checked)} />计划生成后需人工批准</label>{error ? <p className="text-xs text-rose-400">{error}</p> : null}</div><div className="flex justify-end gap-2 border-t border-border px-4 py-3"><Button variant="ghost" size="sm" onClick={onClose}>取消</Button><Button size="sm" disabled={saving} onClick={() => void submit()}>{saving ? '创建中' : '创建'}</Button></div></div></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs text-muted-foreground">{label}</span>{children}</label>
}

function MemoryWorkspace() {
  const [status, setStatus] = useState('candidate')
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try { const data = await api(`/api/steward-memories?status=${status}&limit=100`); setMemories(Array.isArray(data.memories) ? data.memories : []) } catch (err) { setError(err instanceof Error ? err.message : '加载失败') } finally { setLoading(false) }
  }, [status])
  useEffect(() => { setLoading(true); void load() }, [load])
  const action = async (memory: Memory, name: 'approve' | 'reject' | 'expire') => { setBusy(memory.id); try { await api(`/api/steward-memories/${memory.id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name }) }); await load() } catch (err) { setError(err instanceof Error ? err.message : '操作失败') } finally { setBusy(null) } }
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6"><div className="mx-auto max-w-6xl"><div className="mb-4 flex items-center justify-between"><div className="flex gap-1">{['candidate', 'approved', 'rejected', 'expired'].map((item) => <button key={item} onClick={() => setStatus(item)} className={`h-8 px-3 text-xs ${status === item ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground'}`}>{item}</button>)}</div><span className="text-xs text-muted-foreground">{memories.length} 条</span></div>{error ? <p className="mb-3 text-xs text-rose-400">{error}</p> : null}{loading ? <Loader variant="panel" label="加载记忆" /> : <div className="divide-y divide-border border-y border-border">{memories.map((memory) => <article key={memory.id} className="grid gap-3 py-4 md:grid-cols-[150px_1fr_auto]"><div><div className="text-xs font-medium">{memory.category}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{memory.scope_type}:{memory.scope_id}</div><div className="mt-2 text-[10px] text-muted-foreground">置信度 {Math.round(memory.confidence * 100)}%</div></div><div><h3 className="text-sm font-medium">{memory.summary || memory.content.slice(0, 80)}</h3><p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{memory.content}</p><p className="mt-2 text-[10px] text-muted-foreground">来源 {memory.source_refs.length} · {dateTime(memory.updated_at)}</p></div><div className="flex items-start gap-1">{memory.status === 'candidate' ? <><Button size="xs" variant="success" disabled={busy === memory.id} onClick={() => void action(memory, 'approve')}>批准</Button><Button size="xs" variant="destructive" disabled={busy === memory.id} onClick={() => void action(memory, 'reject')}>拒绝</Button></> : null}{memory.status === 'approved' ? <Button size="xs" variant="outline" disabled={busy === memory.id} onClick={() => void action(memory, 'expire')}>失效</Button> : null}</div></article>)}{memories.length === 0 ? <p className="py-10 text-center text-xs text-muted-foreground">暂无记录</p> : null}</div>}</div></div>
}
