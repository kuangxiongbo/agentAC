'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

export const EDGE_DOWNLOAD_PATH = '/edge/download'

function isExternalHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://')
}

export function DownloadIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
    </svg>
  )
}

export function EdgeDownloadHeaderButton({ href = EDGE_DOWNLOAD_PATH }: { href?: string }) {
  const th = useTranslations('header')
  const external = isExternalHref(href)

  if (external) {
    return (
      <Button variant="ghost" size="icon-sm" asChild title={th('downloadEdgeClient')}>
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={th('downloadEdgeClient')}>
          <DownloadIcon />
        </a>
      </Button>
    )
  }

  return (
    <Button variant="ghost" size="icon-sm" asChild title={th('downloadEdgeClient')}>
      <Link href={href} aria-label={th('downloadEdgeClient')}>
        <DownloadIcon />
      </Link>
    </Button>
  )
}

export function EdgeDownloadTooltipLink({ href = EDGE_DOWNLOAD_PATH }: { href?: string }) {
  const th = useTranslations('header')
  const external = isExternalHref(href)
  const className = 'inline-flex items-center gap-1 text-[10px] text-void-cyan hover:underline'

  return (
    <div className="mt-2 pt-2 border-t border-border/40">
      {external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
          <DownloadIcon className="w-3 h-3" />
          {th('downloadEdgeClient')}
        </a>
      ) : (
        <Link href={href} className={className}>
          <DownloadIcon className="w-3 h-3" />
          {th('downloadEdgeClient')}
        </Link>
      )}
    </div>
  )
}
