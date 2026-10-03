'use client'

import { useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ConversationMessages } from './conversation-messages'
import { useConversationStore } from './conversation-provider'
import { TextComposer } from './text-composer'
import { useVoiceRecording } from './voice-recording'
import { Button } from '@/components/ui/button'
import { EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  isActiveGeneration,
  selectCanEdit,
  selectCanSubmit,
  selectNeedsRecovery,
} from '@/lib/client/conversation/types'

export function ConversationScreen({ conversationId }: { conversationId: string | null }) {
  const state = useConversationStore((state) => state)
  const router = useRouter()
  const selectConversation = state.selectConversation
  const submitMessage = state.submit
  useEffect(() => {
    void selectConversation(conversationId)
  }, [conversationId, selectConversation])
  const routeReady = state.conversationId === conversationId
  const submit = useCallback(
    async (text: string) => {
      const accepted = await submitMessage(text)
      if (accepted && accepted.conversationId !== conversationId)
        router.push(`/conversation/${encodeURIComponent(accepted.conversationId)}`)
      return accepted
    },
    [submitMessage, conversationId, router],
  )
  const voice = useVoiceRecording({
    scopeKey: `${state.profile?.id ?? 'anonymous'}:${conversationId ?? 'home'}`,
    onValueChange: state.setDraft,
    onSubmit: submit,
    transcribeRecording: state.transcribeRecording,
  })
  const composer = (
    <TextComposer
      value={state.draft}
      onValueChange={(value) => {
        state.clearActionError()
        voice.clearError()
        state.setDraft(value)
      }}
      preferences={state.preferences}
      catalog={state.catalog}
      onEffortChange={state.setEffort}
      canSubmit={routeReady && selectCanSubmit(state)}
      admissionPending={state.admissionPending}
      preferencePending={state.preferencePending}
      generationActive={routeReady && isActiveGeneration(state.generation)}
      cancelPending={state.cancelPending}
      needsRecovery={routeReady && selectNeedsRecovery(state)}
      onSubmit={submit}
      onCancelResponse={state.cancelResponse}
      onStartRecording={voice.start}
      recording={voice.recording}
      disabled={!routeReady || state.historyLoading || !!state.historyError}
      error={voice.error ?? state.actionError?.message}
    />
  )
  if (!conversationId)
    return (
      <div className='flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4'>
        <div className='flex w-full max-w-3xl flex-col items-center gap-8'>
          <EmptyHeader>
            <EmptyTitle>
              <h1>What would you like to talk about?</h1>
            </EmptyTitle>
          </EmptyHeader>
          {composer}
        </div>
      </div>
    )
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <ConversationMessages
        conversationId={conversationId}
        messages={routeReady ? state.messages : []}
        generation={routeReady ? state.generation : null}
        submission={routeReady ? state.submission : null}
        lastEditableUserMessageId={routeReady ? state.lastEditableUserMessageId : null}
        canEdit={routeReady && selectCanEdit(state)}
        admissionPending={state.admissionPending}
        cancelPending={state.cancelPending}
        historyLoading={!routeReady || state.historyLoading}
        historyError={routeReady ? state.historyError : null}
        transportError={routeReady ? state.transportError : null}
        actionError={state.actionError}
        onReplace={state.replaceMessage}
        onRetry={state.retryGeneration}
        className='min-h-0 flex-1'
      />
      <div className='mx-auto w-full max-w-3xl shrink-0 p-4'>
        {state.historyError && routeReady && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='mb-4'
            onClick={() => void selectConversation(conversationId)}
          >
            Reload conversation
          </Button>
        )}
        {composer}
      </div>
    </div>
  )
}
