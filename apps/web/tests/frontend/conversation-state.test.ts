import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationStore } from '../../lib/client/conversation/store'
import { createConversationApi, validateMessageText } from '../../lib/client/conversation/api'
import {
  selectCanEdit,
  selectCanSubmit,
  selectNeedsRecovery,
  type Conversation,
  type Generation,
  type Message,
} from '../../lib/client/conversation/types'

const preferences = { model: 'gpt-6-luna', effort: 'medium' } as const
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const generationId = '33333333-3333-4333-8333-333333333333'
const nextGenerationId = '44444444-4444-4444-8444-444444444444'
const date = '2026-10-02T00:00:00.000Z'
const conversation = (key = id): Conversation => ({
  id: key,
  title: 'New conversation',
  projectId: null,
  createdAt: date,
  updatedAt: date,
})
const userMessage = (turn = 0): Message => ({
  id: `user-${turn}`,
  turn,
  role: 'user',
  text: `User ${turn}`,
  status: 'completed',
  model: null,
  effort: null,
  generationId: null,
  streamCursor: -1,
  citations: [],
  createdAt: date,
  updatedAt: date,
})
const assistant = (
  status: Message['status'] = 'completed',
  turn = 0,
  identity = generationId,
): Generation => ({
  ...userMessage(turn),
  id: `assistant-${turn}-${identity}`,
  role: 'assistant',
  status,
  model: 'gpt-6-luna',
  effort: 'medium',
  generationId: identity,
  text: 'Answer',
  error: null,
  eventCursor: 0,
})
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((value) => {
    resolve = value
  })
  return { promise, resolve }
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('State did not settle')
}
function backend() {
  let rows: Message[] = [userMessage(), assistant()]
  let generation: Generation | null = rows[1] as Generation
  const calls: {
    path: string
    method: string
    body: Record<string, unknown> | null
    signal?: AbortSignal | null
  }[] = []
  let intercept:
    ((path: string, init: RequestInit) => Promise<Response | null> | Response | null) | undefined
  const fetcher: typeof fetch = async (input, init = {}) => {
    const path = String(input)
    calls.push({
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      signal: init.signal,
    })
    const intercepted = await intercept?.(path, init)
    if (intercepted) return intercepted
    if (path === '/api/me')
      return json({
        id: 'owner',
        firstName: 'Ada',
        lastName: null,
        email: 'ada@example.test',
        image: null,
        spaceId: 'space',
        preferences,
      })
    if (path === '/api/models')
      return json({
        models: [{ id: preferences.model, name: 'Luna', efforts: ['low', 'medium', 'high'] }],
        defaults: preferences,
      })
    if (path === '/api/me/preferences') return json(JSON.parse(String(init.body)))
    if (path.startsWith('/api/conversations?'))
      return json({ conversations: [conversation()], nextCursor: null })
    if (path === '/api/conversations' && init.method === 'POST') return json(conversation(), 201)
    if (path.endsWith('/cancel'))
      return json({ generationId: generation?.generationId, status: generation?.status })
    if (path.includes('/events?')) {
      // Controlled stream remains open until scope teardown; no real server/provider exists.
      return new Response(
        new ReadableStream({
          start(controller) {
            const close = () => controller.close()
            if (init.signal?.aborted) close()
            else init.signal?.addEventListener('abort', close, { once: true })
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    if (path.endsWith('/retry')) {
      const user = rows.filter((row) => row.role === 'user').at(-1)!
      generation = assistant('completed', user.turn, nextGenerationId)
      rows = [...rows.filter((row) => row.id !== rows.at(-1)?.id), generation]
      return json({ userMessageId: user.id, generation, deduplicated: false }, 202)
    }
    if (path.includes('/generations/')) return json(generation)
    if (path.includes('/messages?'))
      return json({
        messages: rows,
        currentGeneration: generation,
        lastEditableUserMessageId: rows.filter((row) => row.role === 'user').at(-1)?.id ?? null,
        nextCursor: null,
      })
    if (path.endsWith('/messages') || (path.includes('/messages/') && init.method === 'PATCH')) {
      const body = JSON.parse(String(init.body))
      const turn = init.method === 'PATCH' ? rows.at(-1)!.turn : rows.length / 2
      const user =
        init.method === 'PATCH'
          ? { ...rows.find((row) => row.id === path.split('/').at(-1))!, text: body.text }
          : { ...userMessage(turn), text: body.text }
      generation = assistant('completed', turn, nextGenerationId)
      rows = [
        ...rows.filter((row) => init.method !== 'PATCH' || row.turn !== turn),
        user,
        generation,
      ]
      return json({ userMessageId: user.id, generation, deduplicated: false }, 202)
    }
    if (path.startsWith('/api/conversations/'))
      return json({
        ...conversation(path.split('/')[3]),
        lastEditableUserMessageId: rows.filter((row) => row.role === 'user').at(-1)?.id ?? null,
        currentGeneration: generation,
      })
    assert.fail(`Unexpected API: ${path}`)
  }
  let sequence = 0
  const store = createConversationStore({
    fetch: fetcher,
    uuid: () => `request-${++sequence}`,
    reconnectDelay: 0,
  })
  return {
    store,
    calls,
    fetcher,
    get generation() {
      return generation
    },
    set generation(value: Generation | null) {
      generation = value
    },
    get rows() {
      return rows
    },
    set rows(value: Message[]) {
      rows = value
    },
    set intercept(value: typeof intercept) {
      intercept = value
    },
  }
}

test('uncertain Home send preserves created conversation, draft, exact body and UUID; changed and intentional sends get fresh IDs', async () => {
  const env = backend()
  env.rows = []
  env.generation = null
  await env.store.getState().initialize()
  let failures = 2
  env.intercept = (path, init) => {
    if (path.endsWith('/messages') && init.method === 'POST' && failures-- > 0)
      throw new Error('Lost response')
    return null
  }
  env.store.getState().setDraft('  café 🦄\n')
  assert.equal(await env.store.getState().submit(), null)
  assert.equal(env.store.getState().draft, '  café 🦄\n')
  assert.equal(await env.store.getState().submit(), null)
  const firstCalls = env.calls.filter((call) => call.path.endsWith('/messages'))
  assert.deepEqual(firstCalls[0].body, firstCalls[1].body)
  assert.equal(firstCalls[0].body?.text, '  café 🦄\n')
  assert.deepEqual(firstCalls[0].body?.preferences, preferences)
  env.store.getState().setDraft('changed')
  const accepted = await env.store.getState().submit()
  assert.equal(accepted?.conversationId, id)
  assert.equal(
    env.calls.filter((call) => call.path === '/api/conversations' && call.method === 'POST').length,
    1,
  )
  assert.notEqual(
    env.calls.filter((call) => call.path.endsWith('/messages')).at(-1)?.body?.requestId,
    firstCalls[0].body?.requestId,
  )
  assert.equal(env.store.getState().draft, '')
  await env.store.getState().selectConversation(id)
  assert.deepEqual(
    env.store.getState().submission,
    accepted,
    'Home acceptance survives navigation into its route',
  )
  assert.equal((await env.store.getState().submit('changed')) !== null, true)
  assert.equal(
    new Set(
      env.calls
        .filter((call) => call.path.endsWith('/messages'))
        .map((call) => call.body?.requestId),
    ).size,
    3,
  )
  await env.store.getState().selectConversation(null)
  env.store.getState().dispose()
})

test('submission lock, validation, preference pair and rejection preserve drafts', async () => {
  const env = backend()
  await env.store.getState().initialize()
  const pending = deferred<Response>()
  env.intercept = (path, init) =>
    path.endsWith('/messages') && init.method === 'POST' ? pending.promise : null
  env.store.getState().setDraft('keep')
  const first = env.store.getState().submit()
  assert.equal(await env.store.getState().submit(), null)
  assert.equal(env.store.getState().admissionPending, true)
  pending.resolve(json({ error: 'Limit' }, 429))
  await first
  assert.equal(env.store.getState().draft, 'keep')
  assert.equal(env.store.getState().actionError?.status, 429)
  for (const invalid of [' ', '\0', '\ud800', '🦄'.repeat(16385)]) {
    const before = env.calls.length
    env.store.getState().setDraft(invalid)
    assert.equal(await env.store.getState().submit(), null)
    assert.equal(env.calls.length, before)
    assert.equal(env.store.getState().draft, invalid)
  }
  assert.equal(validateMessageText('🦄'.repeat(16384)).length, 32768)
  await env.store.getState().setEffort('high')
  assert.deepEqual(env.calls.find((call) => call.path === '/api/me/preferences')?.body, {
    model: preferences.model,
    effort: 'high',
  })
  assert.equal(env.store.getState().preferences?.model, preferences.model)
  env.store.getState().dispose()
})

test('all list/history pages load, including a split latest pair, before edit is enabled', async () => {
  const env = backend()
  const rows = Array.from({ length: 51 }, (_, turn) => [
    userMessage(turn),
    assistant('completed', turn),
  ]).flat()
  env.rows = rows
  env.generation = rows.at(-1) as Generation
  env.intercept = (path) => {
    if (path === '/api/conversations?limit=100')
      return json({ conversations: [conversation()], nextCursor: id })
    if (path.includes('/api/conversations?limit=100&after='))
      return json({ conversations: [conversation(other)], nextCursor: null })
    if (path.endsWith('/messages?limit=100'))
      return json({
        messages: rows.slice(0, 101),
        nextCursor: rows[100].id,
        currentGeneration: env.generation,
        lastEditableUserMessageId: rows[100].id,
      })
    if (path.includes('/messages?limit=100&after='))
      return json({
        messages: rows.slice(101),
        nextCursor: null,
        currentGeneration: env.generation,
        lastEditableUserMessageId: rows[100].id,
      })
    return null
  }
  await env.store.getState().initialize()
  await env.store.getState().refreshConversations()
  assert.deepEqual(
    env.store.getState().conversations.map((value) => value.id),
    [id, other],
  )
  await env.store.getState().selectConversation(id)
  assert.equal(env.store.getState().messages.length, 102)
  assert.equal(env.store.getState().lastEditableUserMessageId, 'user-50')
  assert.equal(selectCanEdit(env.store.getState()), true)
  assert.equal(env.store.getState().generation?.eventCursor, 0)
  env.store.getState().dispose()
})

test('stale route loads and in-flight admission cannot replace the current route or redirect it', async () => {
  const env = backend()
  await env.store.getState().initialize()
  const old = deferred<Response>()
  env.intercept = (path) => (path === `/api/conversations/${id}` ? old.promise : null)
  const stale = env.store.getState().selectConversation(id)
  await env.store.getState().selectConversation(other)
  old.resolve(
    json({
      ...conversation(id),
      currentGeneration: env.generation,
      lastEditableUserMessageId: 'user-0',
    }),
  )
  await stale
  assert.equal(env.store.getState().conversation?.id, other)
  const admission = deferred<Response>()
  env.intercept = (path, init) =>
    path.endsWith('/messages') && init.method === 'POST' ? admission.promise : null
  const pending = env.store.getState().submit('next')
  await env.store.getState().selectConversation(null)
  admission.resolve(
    json(
      { userMessageId: 'user-1', generation: assistant('pending', 1), deduplicated: false },
      202,
    ),
  )
  assert.equal(await pending, null)
  assert.equal(env.store.getState().conversationId, null)
  assert.equal(env.store.getState().messages.length, 0)
  env.store.getState().dispose()
})

function streamFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    }),
  )
  return {
    response,
    emit(type: string, data: unknown, cursor?: number) {
      controller.enqueue(
        new TextEncoder().encode(
          `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        ),
      )
    },
    close() {
      controller.close()
    },
  }
}

test('SSE applies replay IDs once, ignores wrong identities, and replaces text/citations with terminal canonical output', async () => {
  const env = backend()
  env.generation = assistant('running')
  const fixture = streamFixture()
  env.intercept = (path) => (path.includes('/events?') ? fixture.response : null)
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  await until(() => env.calls.some((call) => call.path.includes('/events?after=0')))
  fixture.emit('snapshot', { ...env.generation, text: 'Base', eventCursor: 10 }, 10)
  const event = { messageId: env.generation.id, generationId, delta: ' + delta' }
  fixture.emit('text_delta', event, 11)
  fixture.emit('text_delta', event, 11)
  fixture.emit('text_delta', { ...event, generationId: nextGenerationId }, 12)
  await until(() => env.store.getState().generation?.eventCursor === 11)
  assert.equal(env.store.getState().generation?.text, 'Base + delta')
  const final = {
    ...env.generation,
    text: 'Canonical',
    status: 'completed',
    citations: [{ type: 'url_citation', url: 'https://example.test', title: 'Source' }],
  }
  fixture.emit(
    'completed',
    { messageId: env.generation.id, generationId, status: 'completed', message: final },
    13,
  )
  await until(() => env.store.getState().generation?.status === 'completed')
  assert.equal(env.store.getState().generation?.text, 'Canonical')
  assert.equal(env.store.getState().generation?.citations.length, 1)
  assert.equal(env.store.getState().messages.at(-1)?.text, 'Canonical')
  assert.equal(selectCanEdit(env.store.getState()), true)
  const streamCalls = env.calls.filter((call) => call.path.includes('/events?')).length
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(env.calls.filter((call) => call.path.includes('/events?')).length, streamCalls)
  env.store.getState().dispose()
})

test('transport-only errors and 409 reconnect with canonical cursor without a new paid admission', async () => {
  const env = backend()
  env.generation = assistant('running')
  let attempts = 0
  env.intercept = (path) => {
    if (!path.includes('/events?')) return null
    attempts++
    if (attempts === 1) return json({ error: 'Cursor mismatch' }, 409)
    if (attempts === 2) {
      const fixture = streamFixture()
      fixture.emit('error', { code: 'stream_unavailable', generationId })
      fixture.close()
      return fixture.response
    }
    env.generation = { ...env.generation!, status: 'completed', text: 'Saved', eventCursor: 30 }
    const fixture = streamFixture()
    fixture.emit('snapshot', env.generation, 30)
    fixture.close()
    return fixture.response
  }
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  await until(() => env.store.getState().generation?.status === 'completed')
  assert.equal(env.store.getState().generation?.text, 'Saved')
  assert.equal(
    env.calls.some((call) => call.method !== 'GET'),
    false,
  )
  assert.equal(env.store.getState().transportError, null)
  env.store.getState().dispose()
})

test('only latest user can be replaced, cancelled/failed latest requires recovery, replacement keeps user and changes generation', async () => {
  const env = backend()
  env.rows = [userMessage(), assistant(), userMessage(1), assistant('failed', 1)]
  env.generation = { ...(env.rows.at(-1) as Generation), error: 'provider_error', eventCursor: 4 }
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  assert.equal(selectNeedsRecovery(env.store.getState()), true)
  assert.equal(selectCanSubmit(env.store.getState()), false)
  const before = env.calls.length
  assert.equal(await env.store.getState().submit('append'), null)
  assert.equal(await env.store.getState().replaceMessage('user-0', 'older'), null)
  assert.equal(env.calls.length, before)
  const accepted = await env.store.getState().replaceMessage('user-1', 'replacement')
  assert.equal(accepted?.userMessageId, 'user-1')
  assert.equal(accepted?.generationId, nextGenerationId)
  assert.equal(env.store.getState().messages.length, 4)
  assert.equal(env.store.getState().messages[2].text, 'replacement')
  assert.equal(env.store.getState().messages[3].generationId, nextGenerationId)
  assert.deepEqual(env.store.getState().submission, accepted)
  env.store.getState().dispose()
})

test('cancel waits for authoritative completion, does not erase concurrent response, and errors never invent cancellation', async () => {
  const env = backend()
  env.generation = assistant('running')
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  assert.equal(selectCanEdit(env.store.getState()), false)
  const before = env.calls.length
  assert.equal(await env.store.getState().replaceMessage('user-0', 'edit'), null)
  assert.equal(env.calls.length, before)
  const cancellation = deferred<Response>()
  env.intercept = (path) => (path.endsWith('/cancel') ? cancellation.promise : null)
  const cancel = env.store.getState().cancelResponse()
  assert.equal(env.store.getState().cancelPending, true)
  env.generation = {
    ...env.generation,
    status: 'completed',
    text: 'Finished concurrently',
    eventCursor: 8,
  }
  cancellation.resolve(json({ generationId, status: 'completed' }))
  await cancel
  assert.equal(env.store.getState().generation?.status, 'completed')
  assert.equal(env.store.getState().generation?.text, 'Finished concurrently')
  assert.equal(selectCanEdit(env.store.getState()), true)
  env.generation = assistant('running')
  await env.store.getState().selectConversation(id)
  env.intercept = (path) => (path.endsWith('/cancel') ? json({ error: 'Unavailable' }, 503) : null)
  await env.store.getState().cancelResponse()
  assert.equal(env.store.getState().generation?.status, 'running')
  assert.equal(env.store.getState().generation?.text, 'Answer')
  assert.equal(selectCanEdit(env.store.getState()), false)
  env.store.getState().dispose()
})

test('401 and logout clear all private state and abort transport; foreign conversations stay blocked', async () => {
  const env = backend()
  env.generation = assistant('running')
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  await until(() => env.calls.some((call) => call.path.includes('/events?')))
  env.store.getState().setDraft('private')
  env.intercept = (path) =>
    path === `/api/conversations/${other}` ? json({ error: 'Resource not found' }, 404) : null
  await env.store.getState().selectConversation(other)
  assert.equal(env.store.getState().historyError?.status, 404)
  assert.equal(selectCanSubmit(env.store.getState()), false)
  env.intercept = (path) =>
    path === '/api/me/preferences' ? json({ error: 'Authentication required' }, 401) : null
  await env.store.getState().setEffort('high')
  assert.equal(env.store.getState().sessionStatus, 'anonymous')
  assert.equal(env.store.getState().profile, null)
  assert.deepEqual(env.store.getState().messages, [])
  assert.deepEqual(env.store.getState().conversations, [])
  assert.equal(env.store.getState().draft, '')
  assert.equal(
    env.calls
      .filter((call) => call.path.includes('/events?'))
      .every((call) => call.signal?.aborted),
    true,
  )
  env.intercept = undefined
  await env.store.getState().initialize()
  env.store.getState().setDraft('private again')
  await env.store.getState().logout()
  assert.equal(env.store.getState().draft, '')
  assert.equal(env.store.getState().profile, null)
})

test('SSE parser handles split UTF-8 and CRLF frames', async () => {
  const encoder = new TextEncoder()
  const frame = encoder.encode('id: 1\r\nevent: text_delta\r\ndata: {"delta":"🦄"}\r\n\r\n')
  const api = createConversationApi(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const value of frame) controller.enqueue(Uint8Array.of(value))
            controller.close()
          },
        }),
      ),
  )
  const received: unknown[] = []
  await api.events('/events', new AbortController().signal, (event) => received.push(event))
  assert.deepEqual(received, [{ type: 'text_delta', id: 1, data: { delta: '🦄' } }])
})

test('recording uses shared multipart transport and expires the session on 401 without storing media', async () => {
  const env = backend()
  await env.store.getState().initialize()
  const audio = new Blob(['controlled audio'], { type: 'audio/webm' })
  let received: FormData | undefined
  env.intercept = (path, init) => {
    if (path !== '/api/transcriptions') return null
    received = init.body as FormData
    assert.equal(new Headers(init.headers).has('Content-Type'), false)
    return json({ text: '  original transcript\n' })
  }
  env.store.getState().setDraft('Keep typed draft')
  assert.equal(
    await env.store.getState().transcribeRecording(audio, 'recording.webm'),
    '  original transcript\n',
  )
  assert.deepEqual(Array.from(received!.keys()), ['file'])
  assert.equal((received!.get('file') as File).name, 'recording.webm')
  assert.equal(env.store.getState().draft, 'Keep typed draft')
  env.intercept = (path) =>
    path === '/api/transcriptions' ? json({ error: 'Authentication required' }, 401) : null
  await assert.rejects(env.store.getState().transcribeRecording(audio, 'recording.webm'))
  assert.equal(env.store.getState().sessionStatus, 'anonymous')
  assert.equal(env.store.getState().profile, null)
  assert.equal(env.store.getState().draft, 'Keep typed draft')
})

test('session expiry recovers unsent text only for the same user and route; account change, logout and disposal discard it', async () => {
  const env = backend()
  await env.store.getState().initialize()
  env.store.getState().setDraft('Recover only for owner')
  env.store.getState().expireSession()
  assert.equal(env.store.getState().draft, 'Recover only for owner')
  assert.equal(env.store.getState().profile, null)
  assert.match(env.store.getState().actionError!.message, /Copy your unsent draft/)
  await env.store.getState().initialize()
  assert.equal(env.store.getState().draft, 'Recover only for owner')
  env.store.getState().expireSession()
  env.intercept = (path) =>
    path === '/api/me'
      ? json({
          id: 'different-owner',
          firstName: null,
          lastName: null,
          email: 'other@example.test',
          image: null,
          spaceId: 'other-space',
          preferences,
        })
      : null
  await env.store.getState().initialize()
  assert.equal(env.store.getState().draft, '')
  env.store.getState().setDraft('Other owner private draft')
  env.store.getState().expireSession()
  await env.store.getState().logout()
  await env.store.getState().initialize()
  assert.equal(env.store.getState().draft, '')
  env.store.getState().setDraft('Discard on unmount')
  env.store.getState().expireSession()
  env.store.getState().dispose()
  await env.store.getState().initialize()
  assert.equal(env.store.getState().draft, '')
  env.store.getState().dispose()
})

test('explicit retry preserves latest user identity and an uncertain retry reuses its UUID', async () => {
  const env = backend()
  env.generation = assistant('cancelled')
  env.rows = [userMessage(), env.generation]
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  env.store.getState().setDraft('Unrelated draft remains')
  let first = true
  env.intercept = (path) => {
    if (path.endsWith('/retry') && first) {
      first = false
      throw new Error('Lost admission response')
    }
    return null
  }
  assert.equal(await env.store.getState().retryGeneration(), null)
  const accepted = await env.store.getState().retryGeneration()
  const retries = env.calls.filter((call) => call.path.endsWith('/retry'))
  assert.deepEqual(retries[0].body, retries[1].body)
  assert.equal(retries[0].body?.text, undefined)
  assert.equal(accepted?.userMessageId, 'user-0')
  assert.equal(accepted?.generationId, nextGenerationId)
  assert.equal(env.store.getState().messages.length, 2)
  assert.equal(env.store.getState().draft, 'Unrelated draft remains')
  env.store.getState().dispose()
})

test('Home 409 reconciles the created durable conversation without clearing draft or inventing selection', async () => {
  const env = backend()
  env.rows = []
  env.generation = null
  await env.store.getState().initialize()
  env.intercept = (path, init) => {
    if (path.endsWith('/messages') && init.method === 'POST') {
      env.generation = assistant('running')
      env.rows = [userMessage(), env.generation]
      return json({ error: 'Generation active' }, 409)
    }
    return null
  }
  env.store.getState().setDraft('Keep rejected draft')
  assert.equal(await env.store.getState().submit(), null)
  assert.equal(env.store.getState().draft, 'Keep rejected draft')
  assert.equal(env.store.getState().conversationId, null)
  assert.equal(env.store.getState().actionError?.status, 409)
  assert.equal(
    env.calls.some((call) => call.path === `/api/conversations/${id}`),
    true,
  )
  assert.equal(
    env.calls.some((call) => call.path === `/api/conversations/${id}/generations/${generationId}`),
    true,
  )
  const before = env.calls.filter(
    (call) => call.path === '/api/conversations' && call.method === 'POST',
  ).length
  await env.store.getState().submit()
  assert.equal(
    env.calls.filter((call) => call.path === '/api/conversations' && call.method === 'POST').length,
    before,
  )
  env.store.getState().dispose()
})

test('uncertain latest PATCH retains UUID/body and discarded-generation events cannot replace its new response', async () => {
  const env = backend()
  const oldGeneration = assistant('failed')
  env.generation = oldGeneration
  env.rows = [userMessage(), oldGeneration]
  await env.store.getState().initialize()
  await env.store.getState().selectConversation(id)
  const fixture = streamFixture()
  let first = true
  env.intercept = (path, init) => {
    if (init.method === 'PATCH' && path.includes('/messages/')) {
      if (first) {
        first = false
        throw new Error('Lost replacement response')
      }
      env.generation = assistant('pending', 0, nextGenerationId)
      env.rows = [{ ...userMessage(), text: JSON.parse(String(init.body)).text }, env.generation]
      return json({ userMessageId: 'user-0', generation: env.generation, deduplicated: true }, 202)
    }
    return path.includes('/events?') ? fixture.response : null
  }
  assert.equal(await env.store.getState().replaceMessage('user-0', 'edited'), null)
  assert.equal(env.store.getState().messages[0].text, 'User 0')
  const accepted = await env.store.getState().replaceMessage('user-0', 'edited')
  const patches = env.calls.filter((call) => call.method === 'PATCH')
  assert.deepEqual(patches[0].body, patches[1].body)
  assert.equal(accepted?.userMessageId, 'user-0')
  await until(() => env.calls.some((call) => call.path.includes(nextGenerationId + '/events?')))
  fixture.emit(
    'completed',
    {
      messageId: oldGeneration.id,
      generationId,
      message: { ...oldGeneration, status: 'completed', text: 'Discarded text' },
    },
    50,
  )
  fixture.emit(
    'text_delta',
    { messageId: env.generation!.id, generationId: nextGenerationId, delta: 'New delta' },
    1,
  )
  await until(() => env.store.getState().generation?.eventCursor === 1)
  assert.equal(env.store.getState().generation?.generationId, nextGenerationId)
  assert.equal(env.store.getState().generation?.status, 'pending')
  assert.equal(env.store.getState().messages[0].text, 'edited')
  const final = { ...env.generation!, status: 'completed', text: 'New canonical response' }
  fixture.emit(
    'completed',
    { messageId: final.id, generationId: nextGenerationId, message: final },
    2,
  )
  await until(() => env.store.getState().generation?.status === 'completed')
  assert.equal(env.store.getState().messages[1].text, 'New canonical response')
  env.store.getState().dispose()
})
