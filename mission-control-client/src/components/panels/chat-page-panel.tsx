'use client'

import dynamic from 'next/dynamic'
import { Loader } from '@/components/ui/loader'

function ChatPageSkeleton() {
  return (
    <div className="m-4 flex h-[calc(100vh-8.75rem)] min-h-[560px] flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-full min-h-0">
        <aside className="flex w-72 flex-shrink-0 flex-col border-r border-border p-3">
          <Loader variant="inline" label="正在加载聊天…" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-surface-1" />
            ))}
          </div>
        </aside>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          选择或等待会话列表
        </div>
      </div>
    </div>
  )
}

const ChatWorkspaceLazy = dynamic(
  () => import('@/components/chat/chat-workspace').then((m) => ({ default: m.ChatWorkspace })),
  { loading: () => <ChatPageSkeleton />, ssr: false },
)

export function ChatPagePanel() {
  return (
    <div className="m-4 h-[calc(100vh-8.75rem)] min-h-[560px] overflow-hidden rounded-lg border border-border bg-card">
      <ChatWorkspaceLazy mode="embedded" />
    </div>
  )
}
