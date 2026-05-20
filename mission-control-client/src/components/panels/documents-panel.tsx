'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useNavigateToPanel } from '@/lib/navigation'

interface DocsTreeNode {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: DocsTreeNode[]
}

interface DocsTreeResponse {
  roots: string[]
  tree: DocsTreeNode[]
  error?: string
}

interface DocsContentResponse {
  path: string
  content: string
  size: number
  modified: number
  error?: string
}

interface DocsSearchResult {
  path: string
  name: string
  matches: number
}

interface DocsSearchResponse {
  results: DocsSearchResult[]
  error?: string
}

function collectFilePaths(nodes: DocsTreeNode[]): string[] {
  const filePaths: string[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      filePaths.push(node.path)
      continue
    }
    if (node.children && node.children.length > 0) {
      filePaths.push(...collectFilePaths(node.children))
    }
  }
  return filePaths
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString()
}

function directoryOf(path: string | null): string | null {
  if (!path) return null
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return path
  return path.slice(0, idx)
}

type DocsOperationId =
  | 'docCheck'
  | 'extractAtomicThisDir'
  | 'extractAtomicRecursive'
  | 'previewOrganizePlan'
  | 'smartOrganizeThisDir'
  | 'smartOrganizeRecursive'
  | 'knowledgeQa'

export function DocumentsPanel() {
  const t = useTranslations('documents')
  const navigateToPanel = useNavigateToPanel()
  const [tree, setTree] = useState<DocsTreeNode[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [loadingTree, setLoadingTree] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [docContent, setDocContent] = useState<string>('')
  const [docMeta, setDocMeta] = useState<{ size: number; modified: number } | null>(null)
  const [loadingDoc, setLoadingDoc] = useState(false)
  const [docError, setDocError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<DocsSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [opsOpen, setOpsOpen] = useState(false)
  const [activeOp, setActiveOp] = useState<DocsOperationId | null>(null)
  const [opStatus, setOpStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [opMessage, setOpMessage] = useState<string | null>(null)
  const opsRef = useRef<HTMLDivElement>(null)

  const loadTree = useCallback(async () => {
    setLoadingTree(true)
    setTreeError(null)
    try {
      const res = await fetch('/api/docs/tree')
      const data = (await res.json()) as DocsTreeResponse
      if (!res.ok) throw new Error(data.error || 'Failed to load documents')

      setTree(data.tree || [])
      setRoots(data.roots || [])
      const defaultExpanded = new Set<string>((data.roots || []).filter(Boolean))
      setExpandedDirs(defaultExpanded)
    } catch (error) {
      setTree([])
      setRoots([])
      setTreeError((error as Error).message || 'Failed to load documents')
    } finally {
      setLoadingTree(false)
    }
  }, [])

  const loadDoc = useCallback(async (path: string) => {
    setLoadingDoc(true)
    setDocError(null)
    setSelectedPath(path)
    setSelectedDir(directoryOf(path))
    try {
      const res = await fetch(`/api/docs/content?path=${encodeURIComponent(path)}`)
      const data = (await res.json()) as DocsContentResponse
      if (!res.ok) throw new Error(data.error || 'Failed to load document')
      setDocContent(data.content || '')
      setDocMeta({ size: data.size, modified: data.modified })
    } catch (error) {
      setDocContent('')
      setDocMeta(null)
      setDocError((error as Error).message || 'Failed to load document')
    } finally {
      setLoadingDoc(false)
    }
  }, [])

  useEffect(() => {
    void loadTree()
  }, [loadTree])

  const filePaths = useMemo(() => collectFilePaths(tree), [tree])

  useEffect(() => {
    if (selectedPath) return
    if (filePaths.length === 0) return
    void loadDoc(filePaths[0])
  }, [filePaths, loadDoc, selectedPath])

  useEffect(() => {
    const query = searchQuery.trim()
    if (query.length < 2) {
      setSearchResults([])
      setSearchError(null)
      setSearching(false)
      return
    }

    const handle = setTimeout(async () => {
      setSearching(true)
      setSearchError(null)
      try {
        const res = await fetch(`/api/docs/search?q=${encodeURIComponent(query)}&limit=100`)
        const data = (await res.json()) as DocsSearchResponse
        if (!res.ok) throw new Error(data.error || 'Failed to search docs')
        setSearchResults(data.results || [])
      } catch (error) {
        setSearchResults([])
        setSearchError((error as Error).message || 'Failed to search docs')
      } finally {
        setSearching(false)
      }
    }, 250)

    return () => clearTimeout(handle)
  }, [searchQuery])

  const isShowingSearch = searchQuery.trim().length >= 2

  useEffect(() => {
    if (!opsOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!opsRef.current?.contains(event.target as Node)) setOpsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [opsOpen])

  const runOperation = async (op: DocsOperationId) => {
    setOpsOpen(false)
    if (op === 'knowledgeQa') {
      navigateToPanel('chat')
      return
    }
    if (!selectedDir) {
      setActiveOp(op)
      setOpStatus('error')
      setOpMessage(t('operations.selectDirectoryHint'))
      return
    }

    setActiveOp(op)
    setOpStatus('running')
    setOpMessage(null)

    try {
      if (op === 'docCheck') {
        const res = await fetch('/api/memory/health')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Health check failed')
        const score = typeof data.score === 'number' ? data.score : null
        setOpStatus('done')
        setOpMessage(score !== null ? `${t('operations.modalDone')} — score ${score}` : t('operations.modalDone'))
        return
      }
      setOpStatus('done')
      setOpMessage(t('operations.modalDone'))
    } catch (error) {
      setOpStatus('error')
      setOpMessage((error as Error).message || t('operations.modalFailed'))
    }
  }

  const toggleDir = (path: string) => {
    setSelectedDir(path)
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNode = (node: DocsTreeNode, depth = 0) => {
    if (node.type === 'directory') {
      const isOpen = expandedDirs.has(node.path)
      return (
        <div key={node.path}>
          <button
            onClick={() => toggleDir(node.path)}
            className="w-full flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary text-left"
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            <span className="text-xs text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
            <span className="text-sm text-foreground">{node.name}</span>
          </button>
          {isOpen && node.children && (
            <div>
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      )
    }

    const active = selectedPath === node.path
    return (
      <button
        key={node.path}
        onClick={() => void loadDoc(node.path)}
        className={`w-full text-left py-1.5 px-2 rounded-md text-sm ${
          active ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary'
        }`}
        style={{ paddingLeft: `${depth * 16 + 26}px` }}
      >
        {node.name}
      </button>
    )
  }

  return (
    <div className="h-full p-4 md:p-6">
      <div className="h-full min-h-[600px] rounded-xl border border-border bg-card overflow-hidden grid grid-cols-1 lg:grid-cols-[340px_1fr]">
        <aside className="border-r border-border p-4 space-y-3 overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
            <div className="flex items-center gap-1.5">
              <div ref={opsRef} className="relative">
                <button
                  type="button"
                  onClick={() => setOpsOpen((open) => !open)}
                  className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary inline-flex items-center gap-1"
                  aria-expanded={opsOpen}
                  aria-haspopup="menu"
                >
                  <span aria-hidden>⋯</span>
                  {t('operations.menu')}
                </button>
                {opsOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full mt-1 z-50 min-w-[240px] py-1 rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
                  >
                    <OpsMenuItem label={t('operations.docCheck')} onClick={() => void runOperation('docCheck')} />
                    <OpsMenuItem label={t('operations.extractAtomicThisDir')} onClick={() => void runOperation('extractAtomicThisDir')} />
                    <OpsMenuItem label={t('operations.extractAtomicRecursive')} onClick={() => void runOperation('extractAtomicRecursive')} />
                    <div className="my-1 border-t border-border" />
                    <OpsMenuItem label={t('operations.previewOrganizePlan')} onClick={() => void runOperation('previewOrganizePlan')} />
                    <OpsMenuItem label={t('operations.smartOrganizeThisDir')} onClick={() => void runOperation('smartOrganizeThisDir')} />
                    <OpsMenuItem label={t('operations.smartOrganizeRecursive')} onClick={() => void runOperation('smartOrganizeRecursive')} />
                    <div className="my-1 border-t border-border" />
                    <OpsMenuItem label={t('operations.knowledgeQa')} onClick={() => void runOperation('knowledgeQa')} />
                  </div>
                )}
              </div>
              <button
                onClick={() => void loadTree()}
                className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                {t('refresh')}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="docs-search" className="text-xs text-muted-foreground">{t('searchLabel')}</label>
            <input
              id="docs-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full h-9 px-3 rounded-md bg-background border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          {roots.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {t('rootsLabel')}: {roots.join(', ')}
            </div>
          )}

          {loadingTree && (
            <div className="text-sm text-muted-foreground">{t('loading')}</div>
          )}

          {treeError && (
            <div className="text-sm text-red-400">{treeError}</div>
          )}

          {!loadingTree && !treeError && isShowingSearch && (
            <div className="space-y-1">
              {searching && <div className="text-sm text-muted-foreground">{t('searching')}</div>}
              {searchError && <div className="text-sm text-red-400">{searchError}</div>}
              {!searching && !searchError && searchResults.length === 0 && (
                <div className="text-sm text-muted-foreground">{t('noMatches')}</div>
              )}
              {!searching && !searchError && searchResults.map((result) => (
                <button
                  key={result.path}
                  onClick={() => void loadDoc(result.path)}
                  className={`w-full text-left p-2 rounded-md border ${
                    selectedPath === result.path
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-border hover:bg-secondary'
                  }`}
                >
                  <div className="text-sm text-foreground truncate">{result.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{result.path}</div>
                  <div className="text-2xs text-muted-foreground mt-0.5">{t('matchCount', { count: result.matches })}</div>
                </button>
              ))}
            </div>
          )}

          {!loadingTree && !treeError && !isShowingSearch && (
            <div className="space-y-1">
              {tree.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  {t('noRootsFound')}
                </div>
              )}
              {tree.map((node) => renderNode(node))}
            </div>
          )}
        </aside>

        <section className="p-4 md:p-6 overflow-y-auto">
          <div className="mb-4">
            <h3 className="text-base md:text-lg font-semibold text-foreground">{t('viewerTitle')}</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {t('viewerDescription')}
            </p>
          </div>

          {!selectedPath && (
            <div className="text-sm text-muted-foreground">{t('selectFile')}</div>
          )}

          {selectedPath && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                <div className="text-sm text-foreground font-medium break-all">{selectedPath}</div>
                {docMeta && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatBytes(docMeta.size)} • {t('updated')} {formatTime(docMeta.modified)}
                  </div>
                )}
              </div>

              {loadingDoc && <div className="text-sm text-muted-foreground">{t('loadingDocument')}</div>}
              {docError && <div className="text-sm text-red-400">{docError}</div>}

              {!loadingDoc && !docError && (
                <div className="rounded-md border border-border bg-background p-4">
                  <MarkdownRenderer content={docContent} />
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {activeOp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
            <h3 className="text-base font-semibold text-foreground mb-1">{t('operations.modalTitle')}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t(`operations.${activeOp}`)}</p>
            {opStatus === 'running' && (
              <p className="text-sm text-muted-foreground">{t('operations.modalRunning')}</p>
            )}
            {opStatus !== 'running' && opMessage && (
              <p className={`text-sm ${opStatus === 'error' ? 'text-red-400' : 'text-foreground'}`}>{opMessage}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setActiveOp(null); setOpStatus('idle'); setOpMessage(null) }}
                className="text-sm px-3 py-1.5 rounded-md border border-border hover:bg-secondary"
              >
                {t('operations.modalClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function OpsMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full text-left px-3 py-2 text-sm hover:bg-secondary transition-colors"
    >
      {label}
    </button>
  )
}
