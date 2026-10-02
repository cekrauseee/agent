'use client'

import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'
import type { Submission } from '@/lib/client/conversation/types'

export type TranscriptRow = { id: string; content: ReactNode }
type TranscriptProps = {
  conversationId: string
  submission: Submission | null
  rows: readonly TranscriptRow[]
  className?: string
}
type Turn = { userMessageId: string; ended: boolean }

export function ConversationTranscript(props: TranscriptProps) {
  return (
    <MessageScrollerProvider
      key={props.conversationId}
      autoScroll={false}
      defaultScrollPosition='start'
      scrollPreviousItemPeek={0}
    >
      <Transcript {...props} />
    </MessageScrollerProvider>
  )
}

function Transcript({ conversationId, submission, rows, className }: TranscriptProps) {
  const { scrollToMessage } = useMessageScroller()
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const spacer = useRef<HTMLDivElement>(null)
  const turn = useRef<Turn | null>(null)
  const seen = useRef(new Set<string>())
  const lastTop = useRef(0)
  const userIntent = useRef(false)

  const measure = useCallback(() => {
    const view = viewport.current
    const body = content.current
    const space = spacer.current
    const active = turn.current
    if (!view || !body || !space || !active || active.ended) return
    const items = Array.from(body.children).filter(
      (item): item is HTMLElement =>
        item instanceof HTMLElement && item !== space && !!item.dataset.messageId,
    )
    const anchor = items.find((item) => item.dataset.messageId === active.userMessageId)
    const end = items.at(-1)
    if (!anchor || !end) return
    const style = getComputedStyle(body)
    const inset = parseFloat(style.paddingBlockStart) || 0
    const paddingEnd = parseFloat(style.paddingBlockEnd) || 0
    const occupied = end.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top
    const height = Math.max(0, view.clientHeight - inset - paddingEnd - occupied)
    space.style.height = `${height}px`
    space.style.marginBlockStart = height > 0 ? `-${parseFloat(style.rowGap) || 0}px` : '0px'
    space.hidden = height === 0
    if (height === 0) active.ended = true
  }, [])

  useLayoutEffect(() => {
    const body = content.current
    const view = viewport.current
    if (!body || !view) return
    if (
      submission?.conversationId === conversationId &&
      !seen.current.has(submission.generationId) &&
      rows.some((row) => row.id === submission.userMessageId)
    ) {
      seen.current.add(submission.generationId)
      turn.current = { userMessageId: submission.userMessageId, ended: false }
      userIntent.current = false
      measure()
      scrollToMessage(submission.userMessageId, { align: 'start', behavior: 'instant' })
      lastTop.current = view.scrollTop
    } else {
      measure()
    }
    // Native bottom space can reappear after resize and cannot express irreversible discard.
    // Observe only this transcript's viewport and rows; native commands still own positioning.
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    for (const row of Array.from(body.children)) {
      if (row !== spacer.current && (row as HTMLElement).dataset.messageId) observer.observe(row)
    }
    return () => observer.disconnect()
  }, [conversationId, measure, rows, scrollToMessage, submission])

  const markIntent = () => {
    userIntent.current = true
  }

  return (
    <MessageScroller className={className}>
      <MessageScrollerViewport
        ref={viewport}
        className='[overflow-anchor:none]'
        onWheel={markIntent}
        onTouchMove={markIntent}
        onPointerDown={markIntent}
        onKeyDown={(event) => {
          if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            markIntent()
        }}
        onScroll={() => {
          const view = viewport.current
          const space = spacer.current
          const active = turn.current
          if (!view || !space) return
          const upward = view.scrollTop < lastTop.current
          lastTop.current = view.scrollTop
          if (
            upward &&
            userIntent.current &&
            active &&
            !active.ended &&
            space.getBoundingClientRect().top >= view.getBoundingClientRect().bottom
          ) {
            active.ended = true
            space.style.height = '0px'
            space.hidden = true
          }
        }}
      >
        <MessageScrollerContent
          ref={content}
          className='mx-auto w-full max-w-3xl p-4'
          spacerClassName='hidden!'
        >
          {rows.map((row) => (
            <MessageScrollerItem
              key={row.id}
              messageId={row.id}
              className='[content-visibility:visible]'
            >
              {row.content}
            </MessageScrollerItem>
          ))}
          <MessageScrollerItem
            ref={spacer}
            aria-hidden='true'
            data-turn-spacer=''
            hidden
            className='[content-visibility:visible]'
          />
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton
        behavior='instant'
        onClick={() => {
          if (turn.current) turn.current.ended = true
          if (spacer.current) {
            spacer.current.style.height = '0px'
            spacer.current.hidden = true
          }
        }}
      />
    </MessageScroller>
  )
}
