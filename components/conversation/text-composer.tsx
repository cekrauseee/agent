'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowUpIcon, MicIcon, SquareIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  isSubmitKey,
  messageValidation,
  type RecordingDraft,
} from '@/lib/client/conversation/composer'
import type { Catalog, Effort, Preferences, Submission } from '@/lib/client/conversation/types'
import { cn } from '@/lib/utils'

export type TextComposerProps = {
  value: string
  onValueChange: (value: string) => void
  preferences: Preferences | null
  catalog: Catalog
  onEffortChange: (effort: Effort) => Promise<void>
  canSubmit: boolean
  admissionPending: boolean
  preferencePending: boolean
  generationActive: boolean
  cancelPending: boolean
  needsRecovery: boolean
  onSubmit: (text: string) => Promise<Submission | null>
  onCancelResponse: () => Promise<void>
  onStartRecording?: (draft: RecordingDraft) => void
  recording?: ReactNode
  disabled?: boolean
  error?: string | null
  className?: string
}

export function TextComposer({
  value,
  onValueChange,
  preferences,
  catalog,
  onEffortChange,
  canSubmit,
  admissionPending,
  preferencePending,
  generationActive,
  cancelPending,
  needsRecovery,
  onSubmit,
  onCancelResponse,
  onStartRecording,
  recording,
  disabled = false,
  error,
  className,
}: TextComposerProps) {
  const id = useId()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const submitting = useRef(false)
  const wasRecording = useRef(false)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const efforts = catalog.find((model) => model.id === preferences?.model)?.efforts ?? []
  const validation = messageValidation(value)
  const tooLong = !!value.trim() && !!validation
  const fieldError = (tooLong ? validation : null) ?? error ?? submissionError
  const available = !disabled && canSubmit && !!preferences && efforts.includes(preferences.effort)
  const sendDisabled = !available || !!validation || !!recording || admissionPending

  useEffect(() => {
    if (wasRecording.current && !recording) textarea.current?.focus()
    wasRecording.current = !!recording
  }, [recording])

  async function submit() {
    if (sendDisabled || submitting.current) return
    submitting.current = true
    setSubmissionError(null)
    try {
      await onSubmit(value)
    } catch {
      setSubmissionError('Could not send the message. Your draft is preserved. Try again.')
    } finally {
      submitting.current = false
    }
  }

  return (
    <form
      aria-label='Message composer'
      className={cn('min-w-0 w-full', className)}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={tooLong || undefined} data-disabled={disabled || undefined}>
          {!recording && (
            <FieldLabel htmlFor={id} className='sr-only'>
              Message
            </FieldLabel>
          )}
          <InputGroup>
            {recording ? (
              <InputGroupAddon align='block-end' className='flex-wrap'>
                {recording}
              </InputGroupAddon>
            ) : (
              <>
                <InputGroupTextarea
                  id={id}
                  ref={textarea}
                  name='message'
                  rows={2}
                  value={value}
                  placeholder='Write a message…'
                  disabled={disabled}
                  aria-invalid={tooLong || undefined}
                  aria-describedby={`${id}-status${fieldError ? ` ${id}-error` : ''}`}
                  className='max-h-48 overflow-y-auto'
                  onChange={(event) => {
                    setSubmissionError(null)
                    onValueChange(event.target.value)
                  }}
                  onCompositionStart={() => {
                    composing.current = true
                  }}
                  onCompositionEnd={() => {
                    composing.current = false
                  }}
                  onKeyDown={(event) => {
                    if (
                      isSubmitKey({
                        key: event.key,
                        shiftKey: event.shiftKey,
                        isComposing: composing.current || event.nativeEvent.isComposing,
                      })
                    ) {
                      event.preventDefault()
                      void submit()
                    }
                  }}
                />
                <InputGroupAddon align='block-end' className='flex-wrap gap-2'>
                  <Select
                    items={efforts.map((effort) => ({ label: effort, value: effort }))}
                    value={preferences?.effort ?? null}
                    disabled={disabled || preferencePending || !preferences || !efforts.length}
                    onValueChange={(effort) => {
                      if (effort && efforts.includes(effort)) void onEffortChange(effort)
                    }}
                  >
                    <SelectTrigger aria-label='Reasoning effort' size='sm'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {efforts.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {effort}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className='ms-auto flex flex-wrap items-center gap-2'>
                    {onStartRecording && (
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='Record a message'
                        disabled={!available || admissionPending}
                        onClick={() =>
                          onStartRecording({
                            text: value,
                            selectionStart: textarea.current?.selectionStart ?? null,
                            selectionEnd: textarea.current?.selectionEnd ?? null,
                          })
                        }
                      >
                        <MicIcon aria-hidden='true' />
                      </Button>
                    )}
                    {generationActive ? (
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        disabled={cancelPending}
                        onClick={() => void onCancelResponse()}
                      >
                        {cancelPending ? (
                          <Spinner data-icon='inline-start' />
                        ) : (
                          <SquareIcon data-icon='inline-start' aria-hidden='true' />
                        )}
                        Cancel response
                      </Button>
                    ) : (
                      <Button
                        type='submit'
                        size='icon'
                        aria-label='Send message'
                        disabled={sendDisabled}
                      >
                        {admissionPending ? <Spinner /> : <ArrowUpIcon aria-hidden='true' />}
                      </Button>
                    )}
                  </div>
                </InputGroupAddon>
              </>
            )}
          </InputGroup>
          <FieldDescription id={`${id}-status`} role='status'>
            {needsRecovery
              ? 'Retry the last response or edit the last message before sending another.'
              : admissionPending
                ? 'Sending message…'
                : cancelPending
                  ? 'Cancelling response…'
                  : generationActive
                    ? 'Response in progress. You can keep writing your next draft.'
                    : preferencePending
                      ? 'Saving reasoning effort…'
                      : 'Enter to send · Shift+Enter for a new line'}
          </FieldDescription>
          {fieldError && <FieldError id={`${id}-error`}>{fieldError}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  )
}
