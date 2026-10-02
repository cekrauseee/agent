'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { ConversationTranscript, type TranscriptRow } from './conversation-transcript'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { Spinner } from '@/components/ui/spinner'
import type {
  ClientError,
  Generation,
  Message as SavedMessage,
  Submission,
} from '@/lib/client/conversation/types'

export function safeMessageUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    return url.href
  } catch {
    return
  }
}

export function ConversationMessageContent({ message }: { message: SavedMessage }) {
  const citations = message.citations.filter((citation) => safeMessageUrl(citation.url))
  return (
    <>
      {message.text && (
        <Bubble
          variant={message.role === 'user' ? 'secondary' : 'ghost'}
          align={message.role === 'user' ? 'end' : 'start'}
        >
          <BubbleContent>
            {message.role === 'user' ? (
              <div className='whitespace-pre-wrap'>{message.text}</div>
            ) : (
              <div className='flex min-w-0 flex-col gap-3'>
                <Markdown
                  skipHtml
                  urlTransform={(url) => safeMessageUrl(url) ?? ''}
                  components={{
                    a: ({ href, children }) =>
                      href ? (
                        <a href={href} className='underline' rel='noreferrer'>
                          {children}
                        </a>
                      ) : (
                        <span>{children}</span>
                      ),
                    img: ({ alt }) => <span>{alt}</span>,
                    p: ({ children }) => <p className='whitespace-pre-wrap'>{children}</p>,
                    pre: ({ children }) => (
                      <pre className='max-w-full overflow-x-auto'>{children}</pre>
                    ),
                    ul: ({ children }) => <ul className='list-disc ps-6'>{children}</ul>,
                    ol: ({ children }) => <ol className='list-decimal ps-6'>{children}</ol>,
                  }}
                >
                  {message.text}
                </Markdown>
              </div>
            )}
          </BubbleContent>
        </Bubble>
      )}
      {citations.length > 0 && (
        <nav aria-label='Response sources'>
          <ul className='flex flex-col gap-1'>
            {citations.map((citation, index) => (
              <li key={`${citation.url}:${index}`}>
                <a href={safeMessageUrl(citation.url)} className='underline' rel='noreferrer'>
                  {citation.title || citation.url}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  )
}

export type InlineMessageEditorProps = {
  message: SavedMessage
  isLatest: boolean
  canEdit: boolean
  admissionPending: boolean
  error: ClientError | null
  onReplace: (messageId: string, text: string) => Promise<Submission | null>
  onClose: () => void
}

export function InlineMessageEditor({
  message,
  isLatest,
  canEdit,
  admissionPending,
  error,
  onReplace,
  onClose,
}: InlineMessageEditorProps) {
  const id = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const inFlight = useRef(false)
  const [text, setText] = useState(message.text)
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const problem = !isLatest
    ? 'This conversation changed. Only the latest message can be edited. Your edit is preserved.'
    : localError
      ? (error?.message ?? localError)
      : null

  useEffect(() => {
    input.current?.focus({ preventScroll: true })
  }, [])

  async function replace() {
    if (inFlight.current || !isLatest || !canEdit) return
    if (!text.trim()) {
      setLocalError('Enter a message before resubmitting.')
      input.current?.focus({ preventScroll: true })
      return
    }
    inFlight.current = true
    setPending(true)
    setLocalError(null)
    try {
      const accepted = await onReplace(message.id, text)
      if (accepted) onClose()
      else {
        setLocalError('The edit was not accepted. Your text is preserved; try again.')
        input.current?.focus({ preventScroll: true })
      }
    } catch {
      setLocalError('The edit was not accepted. Your text is preserved; try again.')
      input.current?.focus({ preventScroll: true })
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void replace()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending && !admissionPending) {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <FieldGroup>
        <Field data-invalid={!!problem}>
          <FieldLabel htmlFor={id}>Edit message</FieldLabel>
          <InputGroup>
            <InputGroupTextarea
              ref={input}
              id={id}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setLocalError(null)
              }}
              readOnly={pending || admissionPending}
              aria-invalid={!!problem}
              aria-describedby={problem ? `${id}-error` : undefined}
              rows={3}
            />
            <InputGroupAddon align='block-end' className='flex-wrap justify-end'>
              <InputGroupButton size='sm' disabled={pending || admissionPending} onClick={onClose}>
                Cancel edit
              </InputGroupButton>
              <InputGroupButton
                size='sm'
                variant='default'
                type='submit'
                disabled={pending || admissionPending || !canEdit || !isLatest}
              >
                {(pending || admissionPending) && (
                  <Spinner aria-hidden='true' data-icon='inline-start' />
                )}
                Resubmit
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {problem && <FieldError id={`${id}-error`}>{problem}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  )
}

export type ConversationMessageProps = {
  message: SavedMessage
  lastEditableUserMessageId: string | null
  canEdit: boolean
  admissionPending: boolean
  canRetry: boolean
  error: ClientError | null
  onReplace: InlineMessageEditorProps['onReplace']
  onRetry: () => Promise<Submission | null>
}

export function ConversationMessage({
  message,
  lastEditableUserMessageId,
  canEdit,
  admissionPending,
  canRetry,
  error,
  onReplace,
  onRetry,
}: ConversationMessageProps) {
  const [editing, setEditing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const isLatest = message.role === 'user' && message.id === lastEditableUserMessageId
  const active = message.status === 'pending' || message.status === 'running'
  const incomplete = message.status === 'failed' || message.status === 'cancelled'
  function closeEditor() {
    setEditing(false)
    requestAnimationFrame(() => {
      const target = trigger.current && !trigger.current.disabled ? trigger.current : row.current
      target?.focus({ preventScroll: true })
    })
  }
  return (
    <Message
      ref={row}
      tabIndex={-1}
      align={message.role === 'user' ? 'end' : 'start'}
      data-message-id={message.id}
      data-generation-id={message.generationId}
      data-status={message.status}
    >
      <MessageContent>
        <MessageHeader>{message.role === 'user' ? 'You' : 'Assistant'}</MessageHeader>
        {editing ? (
          <InlineMessageEditor
            message={message}
            isLatest={isLatest}
            canEdit={canEdit}
            admissionPending={admissionPending}
            error={error}
            onReplace={onReplace}
            onClose={closeEditor}
          />
        ) : (
          <ConversationMessageContent message={message} />
        )}
        {message.role === 'assistant' && (
          <>
            <MessageFooter role='status' className='gap-2' aria-live='polite'>
              {active && <Spinner aria-hidden='true' />}
              {message.status === 'pending' && 'Response queued'}
              {message.status === 'running' && 'Generating response'}
            </MessageFooter>
            {incomplete && (
              <Alert role='status'>
                <AlertTitle>
                  {message.status === 'cancelled' ? 'Response cancelled' : 'Response incomplete'}
                </AlertTitle>
                <AlertDescription>
                  {message.text ? 'This partial response is incomplete. ' : ''}
                  {canRetry
                    ? 'Retry this response or edit your latest message to continue.'
                    : 'This response did not complete.'}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
        {isLatest && !editing && (
          <MessageFooter>
            <Button
              ref={trigger}
              type='button'
              variant='ghost'
              size='sm'
              disabled={!canEdit}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </MessageFooter>
        )}
        {canRetry && incomplete && (
          <MessageFooter>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={admissionPending}
              onClick={() => {
                void onRetry()
              }}
            >
              Retry response
            </Button>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}

export type ConversationMessagesProps = {
  conversationId: string
  messages: readonly SavedMessage[]
  generation: Generation | null
  submission: Submission | null
  lastEditableUserMessageId: string | null
  canEdit: boolean
  admissionPending: boolean
  cancelPending: boolean
  historyLoading: boolean
  historyError: ClientError | null
  transportError: ClientError | null
  actionError: ClientError | null
  onReplace: InlineMessageEditorProps['onReplace']
  onRetry: () => Promise<Submission | null>
  className?: string
}

export function ConversationMessages({
  conversationId,
  messages,
  generation,
  submission,
  lastEditableUserMessageId,
  canEdit,
  admissionPending,
  cancelPending,
  historyLoading,
  historyError,
  transportError,
  actionError,
  onReplace,
  onRetry,
  className,
}: ConversationMessagesProps) {
  const rows: TranscriptRow[] = messages.map((saved) => {
    const message = generation?.id === saved.id ? generation : saved
    return {
      id: message.id,
      content: (
        <ConversationMessage
          key={`${conversationId}:${message.id}`}
          message={message}
          lastEditableUserMessageId={lastEditableUserMessageId}
          canEdit={canEdit}
          admissionPending={admissionPending}
          canRetry={
            message.role === 'assistant' &&
            message.generationId === generation?.generationId &&
            !cancelPending &&
            !historyLoading &&
            !historyError
          }
          error={actionError}
          onReplace={onReplace}
          onRetry={onRetry}
        />
      ),
    }
  })
  if (historyLoading)
    rows.push({
      id: 'history-loading',
      content: (
        <Message>
          <MessageContent>
            <MessageFooter role='status' className='gap-2'>
              <Spinner aria-hidden='true' />
              Loading messages
            </MessageFooter>
          </MessageContent>
        </Message>
      ),
    })
  const problem = historyError ?? transportError
  if (problem)
    rows.push({
      id: 'history-feedback',
      content: (
        <Alert variant={historyError ? 'destructive' : 'default'}>
          <AlertTitle>
            {historyError ? 'Unable to load messages' : 'Response updates interrupted'}
          </AlertTitle>
          <AlertDescription>{problem.message}</AlertDescription>
        </Alert>
      ),
    })
  return (
    <ConversationTranscript
      conversationId={conversationId}
      submission={submission}
      rows={rows}
      className={className}
    />
  )
}
