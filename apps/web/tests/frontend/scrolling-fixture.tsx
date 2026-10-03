'use client'

import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { ConversationTranscript } from '@/components/conversation/conversation-transcript'
import type { Submission } from '@/lib/client/conversation/types'

type Row = { id: string; height: number }
type Fixture = {
  conversationId: string
  submission: Submission | null
  rows: Row[]
  composer: number
  sidebar: number
}
declare global {
  interface Window {
    scrollingFixture: (patch: Partial<Fixture>) => void
  }
}

export default function ScrollingFixture() {
  const [fixture, setFixture] = useState<Fixture>({
    conversationId: 'a',
    submission: null,
    rows: [
      { id: 'saved-user', height: 24 },
      { id: 'saved-answer', height: 24 },
    ],
    composer: 80,
    sidebar: 200,
  })
  useEffect(() => {
    window.scrollingFixture = (patch) =>
      flushSync(() => setFixture((state) => ({ ...state, ...patch })))
  }, [])
  return (
    <main className='flex h-svh flex-col pt-12'>
      <div className='flex min-h-0 flex-1'>
        <aside style={{ width: fixture.sidebar }} className='shrink-0'>
          Sidebar fixture
        </aside>
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <div className='min-h-0 flex-1'>
            <ConversationTranscript
              conversationId={fixture.conversationId}
              submission={fixture.submission}
              rows={fixture.rows.map((row) => ({
                id: row.id,
                content: <p style={{ minHeight: row.height }}>Simulated {row.id}</p>,
              }))}
            />
          </div>
          <footer style={{ height: fixture.composer }} className='shrink-0'>
            Composer fixture
          </footer>
        </div>
      </div>
    </main>
  )
}
