import { createStore } from 'zustand/vanilla'
import {
  createConversationApi,
  clientError,
  ConversationApiError,
  validateMessageText,
  type StreamEvent,
} from './api'
import {
  isActiveGeneration,
  selectCanEdit,
  selectCanSubmit,
  type Admission,
  type Catalog,
  type Conversation,
  type ConversationState,
  type Effort,
  type Generation,
  type Message,
  type Preferences,
  type Profile,
  type Submission,
} from './types'

type Options = {
  fetch?: typeof fetch
  uuid?: () => string
  auth?: { signIn: () => Promise<void>; signOut: () => Promise<void> }
  reconnectDelay?: number
}
type History = {
  messages: Message[]
  nextCursor: string | null
  lastEditableUserMessageId: string | null
  currentGeneration: Message | null
}
type Metadata = Conversation & Pick<History, 'lastEditableUserMessageId' | 'currentGeneration'>
const empty = () => ({
  sessionStatus: 'loading' as ConversationState['sessionStatus'],
  profile: null,
  catalog: [],
  preferences: null,
  conversations: [],
  listLoading: false,
  listError: null,
  conversationId: null,
  conversation: null,
  messages: [],
  historyLoading: false,
  historyError: null,
  lastEditableUserMessageId: null,
  generation: null,
  transportError: null,
  draft: '',
  admissionPending: false,
  preferencePending: false,
  cancelPending: false,
  actionError: null,
  submission: null,
})
const segment = encodeURIComponent
const pathFor = (id: string) => `/api/conversations/${segment(id)}`
const generationPath = (id: string, generationId: string) =>
  `${pathFor(id)}/generations/${segment(generationId)}`
const aborted = (signal: AbortSignal) => signal.aborted
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

export function createConversationStore(options: Options = {}) {
  const api = createConversationApi(options.fetch)
  let session = new AbortController()
  let route = new AbortController()
  let stream = new AbortController()
  let list = new AbortController()
  let requestedRoute: string | null = null
  let routeVersion = 0
  let sessionVersion = 0
  let listVersion = 0
  let homeConversationId: string | null = null
  let recovery: { ownerId: string; draft: string; routeId: string | null } | null = null
  const requests = new Map<string, { key: string; requestId: string }>()
  const uuid = options.uuid ?? (() => crypto.randomUUID())
  const store = createStore<ConversationState>()((set, get) => {
    function teardown(
      status: ConversationState['sessionStatus'] = 'anonymous',
      clearRecovery = true,
    ) {
      session.abort()
      route.abort()
      stream.abort()
      list.abort()
      session = new AbortController()
      sessionVersion++
      routeVersion++
      listVersion++
      requests.clear()
      homeConversationId = null
      if (clearRecovery) recovery = null
      set({ ...empty(), sessionStatus: status })
    }
    function expireSession() {
      const state = get()
      if (state.profile)
        recovery = { ownerId: state.profile.id, draft: state.draft, routeId: requestedRoute }
      const draft = recovery?.draft ?? ''
      teardown('anonymous', false)
      set({
        draft,
        actionError: {
          status: 401,
          message:
            'Your session expired. Sign in again.' +
            (draft ? ' Copy your unsent draft before leaving this page.' : ''),
        },
      })
    }
    function fail(
      error: unknown,
      field: 'actionError' | 'historyError' | 'listError' | 'transportError',
    ) {
      const value = clientError(error)
      if (value.status === 401) {
        expireSession()
        if (field !== 'actionError') set({ [field]: value })
      } else set({ [field]: value })
    }
    const scopeMatches = (id: string, version: number) =>
      !route.signal.aborted && requestedRoute === id && routeVersion === version
    function applySnapshot(id: string, version: number, snapshot: Generation, expected?: Message) {
      if (
        !scopeMatches(id, version) ||
        (expected &&
          (snapshot.id !== expected.id || snapshot.generationId !== expected.generationId))
      )
        return
      const current = get().generation
      if (
        current &&
        (snapshot.id !== current.id ||
          snapshot.generationId !== current.generationId ||
          snapshot.eventCursor < current.eventCursor)
      )
        return
      set({
        generation: snapshot,
        messages: get().messages.map((message) =>
          message.id === snapshot.id ? snapshot : message,
        ),
        transportError: null,
        ...(!isActiveGeneration(snapshot) ? { cancelPending: false } : {}),
      })
    }
    function applyEvent(id: string, version: number, expected: Generation, event: StreamEvent) {
      if (!scopeMatches(id, version)) return
      const current = get().generation
      if (!current || current.id !== expected.id || current.generationId !== expected.generationId)
        return
      if (
        event.type === 'error' &&
        event.id === undefined &&
        event.data.code === 'stream_unavailable'
      )
        throw new Error('Stream is unavailable')
      if (event.type === 'snapshot') {
        applySnapshot(id, version, event.data as unknown as Generation, expected)
        return
      }
      if (
        event.data.messageId !== current.id ||
        event.data.generationId !== current.generationId ||
        event.id === undefined ||
        event.id <= current.eventCursor
      )
        return
      let next = { ...current, eventCursor: event.id }
      switch (event.type) {
        case 'text_delta':
          if (typeof event.data.delta !== 'string') throw new Error('Invalid stream delta')
          next.text += event.data.delta
          break
        case 'citations':
          next.citations = event.data.citations as Message['citations']
          break
        case 'status':
          next.status = event.data.status as Message['status']
          break
        case 'completed': {
          const message = event.data.message as Message
          if (message.id !== current.id || message.generationId !== current.generationId) return
          next = { ...message, eventCursor: event.id, error: null }
          break
        }
        case 'error':
          next.status = event.data.status as Message['status']
          next.error = String(event.data.code)
          break
        default:
          return
      }
      applySnapshot(id, version, next, expected)
      if (!isActiveGeneration(next)) stream.abort()
    }
    async function watch(id: string, version: number, expected: Generation) {
      stream.abort()
      const controller = (stream = new AbortController())
      const base = generationPath(id, expected.generationId!)
      while (!controller.signal.aborted && scopeMatches(id, version)) {
        try {
          const snapshot = await api.json<Generation>(base, controller.signal)
          applySnapshot(id, version, snapshot, expected)
          if (!isActiveGeneration(get().generation)) return
          const cursor = get().generation!.eventCursor
          await api.events(`${base}/events?after=${cursor}`, controller.signal, (event) =>
            applyEvent(id, version, expected, event),
          )
        } catch (error) {
          if (controller.signal.aborted || !scopeMatches(id, version)) return
          if (error instanceof ConversationApiError && error.status === 401) {
            fail(error, 'transportError')
            return
          }
          if (error instanceof ConversationApiError && error.status === 404) {
            fail(error, 'historyError')
            return
          }
          fail(error, 'transportError')
        }
        if (!isActiveGeneration(get().generation)) return
        await delay(options.reconnectDelay ?? 1000, controller.signal)
      }
    }
    async function selectConversation(id: string | null) {
      requestedRoute = id
      const version = ++routeVersion
      route.abort()
      stream.abort()
      const controller = (route = new AbortController())
      const keepDraft = get().conversationId === id
      const submission = get().submission
      if (!id && !keepDraft) homeConversationId = null
      set({
        conversationId: id,
        // Same-route reconciliation keeps stable rows mounted, including an unsaved edit buffer.
        ...(keepDraft && get().conversation?.id === id
          ? {}
          : {
              conversation: null,
              messages: [],
              generation: null,
              lastEditableUserMessageId: null,
            }),
        historyLoading: !!id,
        historyError: null,
        transportError: null,
        cancelPending: false,
        actionError: null,
        submission: submission?.conversationId === id ? submission : null,
        ...(!keepDraft ? { draft: '' } : {}),
      })
      if (!id || get().sessionStatus !== 'authenticated') {
        set({ historyLoading: false })
        return
      }
      try {
        const metadata = await api.json<Metadata>(pathFor(id), controller.signal)
        const messages: Message[] = []
        let cursor: string | null = null
        let history: History
        const seen = new Set<string>()
        // Load every page before exposing editability; a page may split a user/assistant pair.
        do {
          history = await api.json<History>(
            `${pathFor(id)}/messages?limit=100${cursor ? `&after=${segment(cursor)}` : ''}`,
            controller.signal,
          )
          messages.push(...history.messages)
          cursor = history.nextCursor
          if (cursor && seen.has(cursor)) throw new Error('History cursor repeated')
          if (cursor) seen.add(cursor)
        } while (cursor)
        const current = history.currentGeneration ?? metadata.currentGeneration
        const generation = current
          ? await api.json<Generation>(generationPath(id, current.generationId!), controller.signal)
          : null
        if (!scopeMatches(id, version)) return
        const unique = Array.from(
          new Map(messages.map((message) => [message.id, message])).values(),
        )
        set({
          conversation: metadata,
          messages: generation
            ? unique.map((message) => (message.id === generation.id ? generation : message))
            : unique,
          lastEditableUserMessageId: history.lastEditableUserMessageId,
          generation,
          historyLoading: false,
        })
        if (generation && isActiveGeneration(generation)) void watch(id, version, generation)
      } catch (error) {
        if (aborted(controller.signal) || !scopeMatches(id, version)) return
        set({ historyLoading: false })
        fail(error, 'historyError')
      }
    }
    async function refreshConversations() {
      if (get().sessionStatus !== 'authenticated') return
      list.abort()
      const controller = (list = new AbortController())
      const version = ++listVersion
      set({ listLoading: true, listError: null })
      try {
        let cursor: string | null = null
        const conversations: Conversation[] = []
        const seen = new Set<string>()
        do {
          const page: { conversations: Conversation[]; nextCursor: string | null } = await api.json(
            `/api/conversations?limit=100${cursor ? `&after=${segment(cursor)}` : ''}`,
            controller.signal,
          )
          conversations.push(...page.conversations)
          cursor = page.nextCursor
          if (cursor && seen.has(cursor)) throw new Error('Conversation cursor repeated')
          if (cursor) seen.add(cursor)
        } while (cursor)
        if (!controller.signal.aborted && version === listVersion)
          set({
            conversations: Array.from(
              new Map(conversations.map((value) => [value.id, value])).values(),
            ),
            listLoading: false,
          })
      } catch (error) {
        if (controller.signal.aborted || version !== listVersion) return
        set({ listLoading: false })
        fail(error, 'listError')
      }
    }
    async function mutate(
      kind: 'send' | 'replace' | 'retry',
      text?: string,
      target?: string,
    ): Promise<Submission | null> {
      const state = get()
      if (
        state.admissionPending ||
        state.preferencePending ||
        state.sessionStatus !== 'authenticated' ||
        !state.preferences
      )
        return null
      if (kind === 'send' && !selectCanSubmit(state)) return null
      if (kind !== 'send' && !selectCanEdit(state)) return null
      if (kind === 'replace' && target !== state.lastEditableUserMessageId) return null
      if (
        kind === 'retry' &&
        state.generation?.status !== 'failed' &&
        state.generation?.status !== 'cancelled'
      )
        return null
      const submittedText = text ?? state.draft
      try {
        if (kind !== 'retry') validateMessageText(submittedText)
      } catch (error) {
        fail(error, 'actionError')
        return null
      }
      const version = routeVersion
      const sessionAtStart = sessionVersion
      const controller = session
      const routeAtStart = requestedRoute
      const preferences = { ...state.preferences }
      set({
        admissionPending: true,
        actionError: null,
        ...(kind === 'send' ? { draft: submittedText } : {}),
      })
      let id = state.conversationId ?? homeConversationId
      try {
        if (!id) {
          const created = await api.json<Conversation>(
            '/api/conversations',
            controller.signal,
            'POST',
            {},
          )
          if (sessionAtStart !== sessionVersion) return null
          id = created.id
          if (routeVersion === version && requestedRoute === routeAtStart) homeConversationId = id
          set({ conversations: [...get().conversations, created] })
        }
        const key = JSON.stringify({
          id,
          kind,
          target,
          text: kind === 'retry' ? undefined : submittedText,
          preferences,
        })
        const previous = requests.get(id)
        const requestId = previous?.key === key ? previous.requestId : uuid()
        requests.set(id, { key, requestId })
        const base = pathFor(id)
        const path =
          kind === 'send'
            ? `${base}/messages`
            : kind === 'replace'
              ? `${base}/messages/${segment(target!)}`
              : `${base}/generations/${segment(target!)}/retry`
        const body = {
          requestId,
          ...(kind === 'retry' ? {} : { text: submittedText }),
          preferences,
        }
        const admission = await api.json<Admission>(
          path,
          controller.signal,
          kind === 'replace' ? 'PATCH' : 'POST',
          body,
        )
        if (sessionAtStart !== sessionVersion) return null
        requests.delete(id)
        const accepted = {
          conversationId: id,
          userMessageId: admission.userMessageId,
          generationId: admission.generation.generationId!,
        }
        const stillSelected = routeVersion === version && requestedRoute === routeAtStart
        if (stillSelected) {
          // Canonical history is loaded by route selection; only the acceptance identity is optimistic.
          set({
            submission: accepted,
            ...(kind === 'send' && get().draft === submittedText ? { draft: '' } : {}),
          })
          if (routeAtStart === id) {
            const draft = get().draft
            const reload = selectConversation(id)
            const reloadVersion = routeVersion
            await reload
            if (requestedRoute === id && routeVersion === reloadVersion)
              set({ submission: accepted, draft })
          }
        }
        void refreshConversations()
        return stillSelected ? accepted : null
      } catch (error) {
        if (controller.signal.aborted || sessionAtStart !== sessionVersion) return null
        if (requestedRoute === routeAtStart && routeVersion === version) {
          let errorVersion = version
          if (error instanceof ConversationApiError && error.status === 409 && id) {
            if (routeAtStart === id) {
              const draft = get().draft
              const reload = selectConversation(id)
              const reloadVersion = routeVersion
              errorVersion = reloadVersion
              await reload
              if (requestedRoute === id && routeVersion === reloadVersion) set({ draft })
            } else {
              // Home has no selected route yet. Reconcile the durable ID without selecting a URL.
              try {
                const current = await api.json<Metadata>(pathFor(id), controller.signal)
                if (current.currentGeneration)
                  await api.json<Generation>(
                    generationPath(id, current.currentGeneration.generationId!),
                    controller.signal,
                  )
                void refreshConversations()
              } catch (reconcileError) {
                if (!controller.signal.aborted) fail(reconcileError, 'actionError')
              }
            }
          }
          if (
            sessionAtStart === sessionVersion &&
            requestedRoute === routeAtStart &&
            routeVersion === errorVersion
          )
            fail(error, 'actionError')
        } else if (error instanceof ConversationApiError && error.status === 401)
          fail(error, 'actionError')
        return null
      } finally {
        if (sessionAtStart === sessionVersion) set({ admissionPending: false })
      }
    }
    return {
      ...empty(),
      async initialize() {
        const savedDraft = recovery
        teardown('loading', false)
        const controller = session
        const version = sessionVersion
        try {
          const [profile, catalog] = await Promise.all([
            api.json<Profile>('/api/me', controller.signal),
            api.json<{ models: Catalog }>('/api/models', controller.signal),
          ])
          if (controller.signal.aborted || version !== sessionVersion) return
          set({
            profile,
            catalog: catalog.models,
            preferences: profile.preferences,
            sessionStatus: 'authenticated',
          })
          void refreshConversations()
          await selectConversation(requestedRoute)
          if (version === sessionVersion) {
            if (savedDraft?.ownerId === profile.id && savedDraft.routeId === requestedRoute)
              set({ draft: savedDraft.draft })
            recovery = null
          }
        } catch (error) {
          if (controller.signal.aborted || version !== sessionVersion) return
          if (error instanceof ConversationApiError && error.status === 401)
            fail(error, 'actionError')
          else {
            set({ sessionStatus: 'error' })
            fail(error, 'actionError')
          }
        }
      },
      expireSession,
      async signIn() {
        try {
          await options.auth?.signIn()
        } catch {
          set({ actionError: { status: null, message: 'Sign-in failed. Try again.' } })
        }
      },
      async logout() {
        // Private state is removed immediately, including when remote logout fails.
        teardown()
        try {
          await options.auth?.signOut()
        } catch {
          set({ actionError: { status: null, message: 'Sign-out failed. Try again.' } })
        }
      },
      selectConversation,
      refreshConversations,
      setDraft: (draft) => set({ draft }),
      startNewConversation() {
        // The caller navigates to Home; this clears even when its URL is already selected.
        routeVersion++
        route.abort()
        stream.abort()
        if (homeConversationId) requests.delete(homeConversationId)
        homeConversationId = null
        recovery = null
        set({ draft: '', actionError: null, submission: null })
      },
      async setEffort(effort: Effort) {
        const state = get()
        if (!state.preferences || state.preferencePending || state.admissionPending) return
        if (
          !state.catalog
            .find((model) => model.id === state.preferences!.model)
            ?.efforts.includes(effort)
        )
          return
        const version = sessionVersion
        const controller = session
        const preferences: Preferences = { model: state.preferences.model, effort }
        set({ preferencePending: true, actionError: null })
        try {
          const saved = await api.json<Preferences>(
            '/api/me/preferences',
            controller.signal,
            'PATCH',
            preferences,
          )
          if (version === sessionVersion)
            set({
              preferences: saved,
              profile: get().profile ? { ...get().profile!, preferences: saved } : null,
            })
        } catch (error) {
          if (!controller.signal.aborted && version === sessionVersion) fail(error, 'actionError')
        } finally {
          if (version === sessionVersion) set({ preferencePending: false })
        }
      },
      submit: (text) => mutate('send', text),
      replaceMessage: (messageId, text) => mutate('replace', text, messageId),
      retryGeneration: () =>
        mutate('retry', undefined, get().generation?.generationId ?? undefined),
      async cancelResponse() {
        const state = get()
        if (
          !state.conversationId ||
          !state.generation ||
          !isActiveGeneration(state.generation) ||
          state.cancelPending ||
          state.admissionPending
        )
          return
        const id = state.conversationId
        const expected = state.generation
        const version = routeVersion
        const controller = route
        set({ cancelPending: true, actionError: null })
        try {
          const path = generationPath(id, expected.generationId!)
          await api.json(path + '/cancel', controller.signal, 'POST')
          const snapshot = await api.json<Generation>(path, controller.signal)
          applySnapshot(id, version, snapshot, expected)
          if (scopeMatches(id, version) && isActiveGeneration(get().generation))
            void watch(id, version, expected)
        } catch (error) {
          if (controller.signal.aborted || !scopeMatches(id, version)) return
          set({ cancelPending: false })
          fail(error, 'actionError')
          // A rejected cancellation can race completion; fetch authoritative state, never invent cancelled.
          if (error instanceof ConversationApiError && error.status === 409) {
            try {
              applySnapshot(
                id,
                version,
                await api.json<Generation>(
                  generationPath(id, expected.generationId!),
                  controller.signal,
                ),
                expected,
              )
            } catch (snapshotError) {
              if (!controller.signal.aborted) fail(snapshotError, 'transportError')
            }
          }
        }
      },
      async transcribeRecording(audio, filename, signal) {
        if (get().sessionStatus !== 'authenticated')
          throw new ConversationApiError(401, 'Sign in to transcribe a recording.')
        const controller = session
        const version = sessionVersion
        const uploadSignal = signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal
        const body = new FormData()
        body.set('file', audio, filename)
        try {
          const result = await api.upload<{ text: string }>(
            '/api/transcriptions',
            uploadSignal,
            body,
          )
          if (uploadSignal.aborted || version !== sessionVersion)
            throw new DOMException('Recording was discarded', 'AbortError')
          return result.text
        } catch (error) {
          if (
            !uploadSignal.aborted &&
            version === sessionVersion &&
            error instanceof ConversationApiError &&
            error.status === 401
          )
            fail(error, 'actionError')
          throw error
        }
      },
      clearActionError: () => set({ actionError: null }),
      dispose: () => teardown(),
    }
  })
  return store
}
export type ConversationStore = ReturnType<typeof createConversationStore>
