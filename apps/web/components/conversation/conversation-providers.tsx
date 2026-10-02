'use client'

import { useId, useState, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import { HomeShell } from './home-shell'
import { ConversationProvider, useConversationStore } from './conversation-provider'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { TooltipProvider } from '@/components/ui/tooltip'

export function ConversationProviders({ children }: { children: ReactNode }) {
  return (
    <ConversationProvider>
      <TooltipProvider>
        <SessionBoundary>{children}</SessionBoundary>
      </TooltipProvider>
    </ConversationProvider>
  )
}

function SessionBoundary({ children }: { children: ReactNode }) {
  const state = useConversationStore((state) => state)
  const [signingIn, setSigningIn] = useState(false)
  const draftId = useId()
  const params = useParams<{ id?: string }>()
  if (state.sessionStatus === 'authenticated')
    return (
      <HomeShell navigation={state} conversationId={params.id ?? null}>
        {children}
      </HomeShell>
    )
  const loading = state.sessionStatus === 'loading'
  const failed = state.sessionStatus === 'error'
  const expired = state.actionError?.status === 401

  async function signIn() {
    setSigningIn(true)
    try {
      await state.signIn()
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <main className='flex min-h-dvh min-w-0 flex-col overflow-y-auto'>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>
              {loading
                ? 'Loading your workspace'
                : failed
                  ? 'Unable to load your workspace'
                  : expired
                    ? 'Your session expired'
                    : 'Sign in to Agent'}
            </h1>
          </EmptyTitle>
          <EmptyDescription>
            {loading
              ? 'Loading your profile and conversations…'
              : (state.actionError?.message ?? 'Continue with Google to start a conversation.')}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {loading ? (
            <Spinner aria-label='Loading workspace' />
          ) : (
            <>
              {state.draft && (
                <Field>
                  <FieldLabel htmlFor={draftId}>Unsent draft</FieldLabel>
                  <Textarea
                    id={draftId}
                    value={state.draft}
                    readOnly
                    rows={5}
                    className='max-h-64 overflow-y-auto'
                    aria-describedby={`${draftId}-warning`}
                  />
                  <FieldDescription id={`${draftId}-warning`}>
                    Copy this draft before signing in. Google sign-in reloads the page, and this
                    draft is kept only on this page.
                  </FieldDescription>
                </Field>
              )}
              <Button
                type='button'
                disabled={signingIn}
                onClick={() => (failed ? void state.initialize() : void signIn())}
              >
                {signingIn && <Spinner data-icon='inline-start' />}
                {failed ? 'Retry loading' : signingIn ? 'Signing in…' : 'Sign in with Google'}
              </Button>
            </>
          )}
        </EmptyContent>
      </Empty>
    </main>
  )
}
