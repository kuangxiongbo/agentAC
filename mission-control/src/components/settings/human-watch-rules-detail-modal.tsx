'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { HumanWatchRulesConfig } from '@/components/panels/human-watch-rules-config'

export function HumanWatchRulesDetailModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved?: () => void | Promise<void>
}) {
  const ts = useTranslations('settings')
  const th = useTranslations('humanWatch')

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{th('rulesDetailModalTitle')}</h3>
            <p className="text-2xs text-muted-foreground mt-0.5">{th('rulesDetailModalHint')}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {ts('humanWatchRulesModalClose')}
          </Button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">
          <HumanWatchRulesConfig
            variant="detail"
            onSaved={async () => {
              await onSaved?.()
              onClose()
            }}
          />
        </div>
      </div>
    </div>
  )
}
