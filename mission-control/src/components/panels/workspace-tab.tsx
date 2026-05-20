'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface WorkspaceRow {
  id: string
  name: string
  path: string
  description?: string
  isDefault: boolean
  agentCount?: number
  createdAt: number
  updatedAt: number
}

const emptyForm = {
  name: '',
  path: '',
  description: '',
  isDefault: false,
  createIfMissing: true,
}

export function WorkspaceTab() {
  const t = useTranslations('workspaces')
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [formMode, setFormMode] = useState<'hidden' | 'create' | 'edit'>('hidden')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const fetchWorkspaces = useCallback(async () => {
    try {
      const res = await fetch('/api/workspaces')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      setWorkspaces(data.workspaces || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void fetchWorkspaces()
  }, [fetchWorkspaces])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 4000)
    return () => clearTimeout(timer)
  }, [success])

  const closeForm = () => {
    setFormMode('hidden')
    setEditingId(null)
    setForm({ ...emptyForm })
    setError(null)
    setSuccess(null)
  }

  const startCreate = () => {
    setFormMode('create')
    setEditingId(null)
    setForm({ ...emptyForm })
    setError(null)
  }

  const startEdit = (ws: WorkspaceRow) => {
    setFormMode('edit')
    setEditingId(ws.id)
    setForm({
      name: ws.name,
      path: ws.path,
      description: ws.description || '',
      isDefault: ws.isDefault,
      createIfMissing: true,
    })
    setError(null)
    setSuccess(null)
  }

  const saveWorkspace = async () => {
    if (!form.name.trim() || !form.path.trim()) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const payload = {
        name: form.name.trim(),
        path: form.path.trim(),
        description: form.description.trim() || undefined,
        isDefault: form.isDefault,
        createIfMissing: form.createIfMissing,
      }
      const res = await fetch('/api/workspaces', {
        method: formMode === 'edit' && editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formMode === 'edit' && editingId ? { id: editingId, ...payload } : payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('saveFailed'))
      const createdDir = Boolean(data.directoryCreated)
      closeForm()
      await fetchWorkspaces()
      if (createdDir) setSuccess(t('directoryCreated'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const deleteWorkspace = async (id: string) => {
    if (!window.confirm(t('deleteConfirm'))) return
    setError(null)
    try {
      const res = await fetch(`/api/workspaces?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('deleteFailed'))
      await fetchWorkspaces()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteFailed'))
    }
  }

  const setAsDefault = async (ws: WorkspaceRow) => {
    if (ws.isDefault) return
    setError(null)
    try {
      const res = await fetch('/api/workspaces', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ws.id, isDefault: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('saveFailed'))
      await fetchWorkspaces()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground max-w-xl">{t('description')}</p>
        <div className="flex items-center gap-2 shrink-0">
          {formMode === 'hidden' && (
            <Button size="sm" onClick={startCreate}>
              {t('add')}
            </Button>
          )}
          {formMode !== 'hidden' && (
            <Button size="sm" variant="secondary" onClick={closeForm}>
              {t('cancel')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-300">
          {success}
        </div>
      )}

      {formMode !== 'hidden' && (
        <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-3">
          <div className="text-xs font-medium text-foreground">
            {formMode === 'edit' ? t('editTitle') : t('createTitle')}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t('name')}</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('namePlaceholder')}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="text-muted-foreground">{t('path')}</span>
              <input
                value={form.path}
                onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                placeholder={t('pathPlaceholder')}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm font-mono text-foreground"
              />
            </label>
            <label className="space-y-1 text-xs sm:col-span-2">
              <span className="text-muted-foreground">{t('descriptionOptional')}</span>
              <input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t('descriptionPlaceholder')}
                className="w-full h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.createIfMissing}
              onChange={(e) => setForm((f) => ({ ...f, createIfMissing: e.target.checked }))}
              className="rounded border-border"
            />
            {t('createIfMissing')}
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
              className="rounded border-border"
            />
            {t('setAsDefault')}
          </label>
          <Button size="sm" onClick={() => void saveWorkspace()} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      )}

      {workspaces.length === 0 && formMode === 'hidden' ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          {t('empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{ws.name}</span>
                  {ws.isDefault && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
                      {t('defaultBadge')}
                    </span>
                  )}
                  {(ws.agentCount ?? 0) > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {t('agentCount', { count: ws.agentCount ?? 0 })}
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-muted-foreground truncate mt-0.5" title={ws.path}>
                  {ws.path}
                </div>
                {ws.description && (
                  <div className="text-[11px] text-muted-foreground/70 mt-0.5">{ws.description}</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {!ws.isDefault && (
                  <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void setAsDefault(ws)}>
                    {t('makeDefault')}
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => startEdit(ws)}>
                  {t('edit')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px] text-red-400/80 hover:text-red-300"
                  onClick={() => void deleteWorkspace(ws.id)}
                >
                  {t('delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
