'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowUpIcon, SquareIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { VoiceRecorder, type VoiceState } from '@/lib/client/conversation/voice'
import type { RecordingDraft } from '@/lib/client/conversation/composer'

export type VoiceRecordingOptions = {
  /** Session identity and route identity; changes dispose previous recording/upload work. */
  scopeKey: string
  onValueChange: (text: string) => void
  onSubmit: (text: string) => Promise<unknown>
  transcribeRecording: (audio: Blob, filename: string, signal?: AbortSignal) => Promise<string>
}

export function useVoiceRecording({ scopeKey, ...callbacks }: VoiceRecordingOptions) {
  const [recorder] = useState(() => new VoiceRecorder(callbacks))
  useEffect(() => {
    recorder.setCallbacks(callbacks)
  })
  useEffect(() => {
    recorder.cancel()
    return recorder.dispose
  }, [recorder, scopeKey])
  const state = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot)
  return {
    start: (draft: RecordingDraft) => void recorder.start(draft),
    cancel: recorder.cancel,
    clearError: recorder.clearError,
    error: state.error,
    recording: state.phase === 'idle' ? null : <VoiceRecording state={state} recorder={recorder} />,
  }
}

function VoiceRecording({ state, recorder }: { state: VoiceState; recorder: VoiceRecorder }) {
  const recording = state.phase === 'recording'
  const label =
    state.phase === 'requesting'
      ? 'Waiting for microphone…'
      : state.phase === 'transcribing'
        ? 'Transcribing…'
        : state.phase === 'submitting'
          ? 'Sending message…'
          : 'Recording…'
  return (
    <div
      role='group'
      className='flex w-full min-w-0 items-center gap-2'
      aria-label='Voice recording'
    >
      <Button
        type='button'
        variant='ghost'
        size='icon'
        aria-label='Cancel recording'
        disabled={state.phase === 'submitting'}
        onClick={recorder.cancel}
      >
        <XIcon aria-hidden='true' />
      </Button>
      <div className='flex min-w-0 flex-1 flex-col items-center gap-1'>
        {recording && (
          <svg
            viewBox='0 0 200 40'
            className='h-10 w-full motion-reduce:hidden'
            preserveAspectRatio='none'
            aria-hidden='true'
          >
            <polyline points={state.waveform} fill='none' stroke='currentColor' strokeWidth='1.5' />
          </svg>
        )}
        <span role='status'>{label}</span>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <Button
          type='button'
          variant='outline'
          size='icon'
          aria-label='Stop and transcribe'
          disabled={!recording}
          onClick={() => recorder.finish('insert')}
        >
          <SquareIcon aria-hidden='true' />
        </Button>
        <Button
          type='button'
          size='icon'
          aria-label='Transcribe and send message'
          disabled={!recording}
          onClick={() => recorder.finish('send')}
        >
          {state.phase === 'transcribing' || state.phase === 'submitting' ? (
            <Spinner />
          ) : (
            <ArrowUpIcon aria-hidden='true' />
          )}
        </Button>
      </div>
    </div>
  )
}
