'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { authClient } from '@/lib/client/conversation/auth'
import { createConversationStore, type ConversationStore } from '@/lib/client/conversation/store'
import type { ConversationState } from '@/lib/client/conversation/types'

const Context = createContext<ConversationStore | null>(null)

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() =>
    createConversationStore({
      auth: {
        async signIn() {
          const result = await authClient.signIn.social({
            provider: 'google',
            callbackURL: window.location.href,
          })
          if (result.error) throw new Error(result.error.message ?? 'Sign-in failed')
        },
        async signOut() {
          const result = await authClient.signOut()
          if (result.error) throw new Error(result.error.message ?? 'Sign-out failed')
        },
      },
    }),
  )
  const session = authClient.useSession()
  useEffect(() => {
    void store.getState().initialize()
    return () => store.getState().dispose()
  }, [store])
  // Better Auth updates this hook when another tab signs out or a session expires.
  useEffect(() => {
    if (!session.isPending && !session.data && store.getState().sessionStatus === 'authenticated')
      store.getState().expireSession()
    else if (
      session.data &&
      (store.getState().sessionStatus === 'anonymous' ||
        (store.getState().profile && session.data.user.id !== store.getState().profile?.id))
    )
      void store.getState().initialize()
  }, [session.data, session.isPending, store])
  return <Context value={store}>{children}</Context>
}

export function useConversationStore<T>(selector: (state: ConversationState) => T): T {
  const store = useContext(Context)
  if (!store) throw new Error('ConversationProvider is required')
  return useStore(store, selector)
}
