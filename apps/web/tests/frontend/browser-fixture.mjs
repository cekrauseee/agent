// Browser-only QA transport. Never import this file into the application.
;(() => {
  const nativeFetch = window.fetch.bind(window)
  const storageKey = 'conversation-browser-fixture'
  const timestamp = '2026-10-02T12:00:00.000Z'
  const streams = new Map()
  const requests = []
  let nextFailure = null
  let transcription = { text: 'Simulated voice transcript.' }
  let microphoneDenied = false
  const initial = () => ({
    authenticated: true,
    preferences: { model: 'gpt-6-luna', effort: 'medium' },
    conversations: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        projectId: null,
        title: 'Saved conversation',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
        events: {},
        admissions: {},
      },
    ],
  })
  let state = JSON.parse(sessionStorage.getItem(storageKey) || 'null') || initial()
  const save = () => sessionStorage.setItem(storageKey, JSON.stringify(state))
  const publicConversation = ({
    messages: _messages,
    events: _events,
    admissions: _admissions,
    ...value
  }) => value
  const current = (conversation) =>
    conversation.messages.findLast((message) => message.role === 'assistant') || null
  const editable = (conversation) =>
    conversation.messages.findLast((message) => message.role === 'user')?.id || null
  const message = (role, text, turn, preferences = state.preferences) => ({
    id: crypto.randomUUID(),
    turn,
    role,
    text,
    status: role === 'assistant' ? 'pending' : 'completed',
    model: role === 'assistant' ? preferences.model : null,
    effort: role === 'assistant' ? preferences.effort : null,
    generationId: role === 'assistant' ? crypto.randomUUID() : null,
    streamCursor: -1,
    citations: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const frame = (event) =>
    new TextEncoder().encode(
      `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    )
  const publish = (conversation, generation, type, data) => {
    const events = (conversation.events[generation.generationId] ||= [])
    const event = { id: events.length + 1, type, data }
    events.push(event)
    for (const controller of streams.get(generation.generationId) || [])
      controller.enqueue(frame(event))
    save()
  }
  const generationFor = (id) => {
    const conversation = state.conversations.find((entry) =>
      entry.messages.some((entry) => entry.generationId === id),
    )
    if (!conversation) throw new Error(`Unknown fixture generation: ${id}`)
    return {
      conversation,
      generation: conversation.messages.find((entry) => entry.generationId === id),
    }
  }
  const snapshot = (conversation, generation) => ({
    ...generation,
    error: generation.status === 'failed' ? 'generation_failed' : null,
    eventCursor: (conversation.events[generation.generationId] || []).length,
  })
  const terminal = (id, status, text) => {
    const { conversation, generation } = generationFor(id)
    generation.status = status
    if (text !== undefined) generation.text = text
    publish(conversation, generation, status === 'completed' ? 'completed' : 'error', {
      messageId: generation.id,
      generationId: id,
      status,
      ...(status === 'completed'
        ? {}
        : { code: status === 'cancelled' ? 'generation_cancelled' : 'generation_failed' }),
      message: { ...generation },
    })
    for (const controller of streams.get(id) || []) controller.close()
    streams.delete(id)
  }
  window.__conversationFixture = {
    requests,
    get state() {
      return state
    },
    reset() {
      state = initial()
      save()
      location.reload()
    },
    expire() {
      state.authenticated = false
      save()
    },
    failNext(path, status = 409, error = 'Simulated rejection') {
      nextFailure = { path, status, error }
    },
    transcribe(text) {
      transcription = { text }
    },
    denyMicrophone(value = true) {
      microphoneDenied = value
    },
    latestGeneration() {
      return current(state.conversations.at(-1))?.generationId
    },
    delta(id, delta) {
      const { conversation, generation } = generationFor(id)
      if (generation.status === 'pending') {
        generation.status = 'running'
        publish(conversation, generation, 'status', {
          messageId: generation.id,
          generationId: id,
          status: 'running',
        })
      }
      generation.text += delta
      generation.streamCursor++
      publish(conversation, generation, 'text_delta', {
        messageId: generation.id,
        generationId: id,
        delta,
        outputIndex: 0,
        contentIndex: 0,
      })
    },
    complete(id, text) {
      terminal(id, 'completed', text)
    },
    fail(id) {
      terminal(id, 'failed')
    },
    disconnect(id) {
      for (const controller of streams.get(id) || []) controller.close()
      streams.delete(id)
    },
    seedHistory(count = 12) {
      const conversation = state.conversations[0]
      conversation.messages = Array.from({ length: count }, (_, turn) => {
        const user = message('user', `Saved question ${turn + 1}`, turn)
        const assistant = message('assistant', `Saved answer ${turn + 1}.\n`.repeat(12), turn)
        assistant.status = 'completed'
        return [user, assistant]
      }).flat()
      save()
      return conversation.id
    },
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input.url || String(input),
      location.href,
    )
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/'))
      return nativeFetch(input, init)
    const method = init.method || (input instanceof Request ? input.method : 'GET')
    const path = url.pathname
    requests.push({ path, method, body: typeof init.body === 'string' ? init.body : null })
    if (nextFailure && path.includes(nextFailure.path)) {
      const failure = nextFailure
      nextFailure = null
      return json({ error: failure.error }, failure.status)
    }
    if (path === '/api/auth/get-session')
      return json(
        state.authenticated
          ? {
              session: {
                id: 'fixture-session',
                userId: 'fixture-user',
                expiresAt: '2099-01-01T00:00:00.000Z',
                createdAt: timestamp,
                updatedAt: timestamp,
                token: 'fixture-token',
              },
              user: {
                id: 'fixture-user',
                name: 'QA User',
                email: 'qa@example.test',
                emailVerified: true,
                image: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            }
          : null,
      )
    if (path === '/api/auth/sign-out') {
      state.authenticated = false
      save()
      return json({ success: true })
    }
    if (path === '/api/auth/sign-in/social') return json({ url: location.origin, redirect: false })
    if (!state.authenticated) return json({ error: 'Unauthorized' }, 401)
    if (path === '/api/me')
      return json({
        id: 'fixture-user',
        firstName: 'QA',
        lastName: 'User',
        email: 'qa@example.test',
        image: null,
        preferences: state.preferences,
        spaceId: 'fixture-space',
      })
    if (path === '/api/models')
      return json({
        models: [
          {
            id: 'gpt-6-luna',
            name: 'GPT-6 Luna',
            efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        defaults: state.preferences,
      })
    if (path === '/api/me/preferences') {
      if (method === 'PATCH') {
        state.preferences = JSON.parse(init.body)
        save()
      }
      return json(state.preferences)
    }
    if (path === '/api/transcriptions') return json(transcription)
    if (path === '/api/conversations') {
      if (method === 'POST') {
        const conversation = {
          ...initial().conversations[0],
          id: crypto.randomUUID(),
          title: 'New conversation',
        }
        state.conversations.push(conversation)
        save()
        return json(publicConversation(conversation), 201)
      }
      const start = url.searchParams.get('after')
        ? state.conversations.findIndex((entry) => entry.id === url.searchParams.get('after')) + 1
        : 0
      const page = state.conversations.slice(
        start,
        start + Number(url.searchParams.get('limit') || 50),
      )
      return json({
        conversations: page.map(publicConversation),
        nextCursor: start + page.length < state.conversations.length ? page.at(-1).id : null,
      })
    }
    const match = path.match(/^\/api\/conversations\/([^/]+)(.*)$/)
    const conversation = match && state.conversations.find((entry) => entry.id === match[1])
    if (!conversation) return json({ error: `Unconfigured fixture API: ${method} ${path}` }, 404)
    const suffix = match[2]
    if (!suffix)
      return json({
        ...publicConversation(conversation),
        lastEditableUserMessageId: editable(conversation),
        currentGeneration: current(conversation),
      })
    if (suffix === '/messages' && method === 'GET') {
      const start = url.searchParams.get('after')
        ? conversation.messages.findIndex((entry) => entry.id === url.searchParams.get('after')) + 1
        : 0
      const page = conversation.messages.slice(
        start,
        start + Number(url.searchParams.get('limit') || 50),
      )
      return json({
        messages: page,
        nextCursor: start + page.length < conversation.messages.length ? page.at(-1).id : null,
        lastEditableUserMessageId: editable(conversation),
        currentGeneration: current(conversation),
      })
    }
    if (
      (suffix === '/messages' || /^\/messages\/[^/]+$/.test(suffix) || suffix.endsWith('/retry')) &&
      ['POST', 'PATCH'].includes(method)
    ) {
      const body = JSON.parse(init.body)
      const prior = conversation.admissions[body.requestId]
      if (prior) return json({ ...prior, deduplicated: true }, 202)
      if (['pending', 'running'].includes(current(conversation)?.status))
        return json({ error: 'Response still active' }, 409)
      let user
      if (suffix === '/messages') {
        user = message('user', body.text, (current(conversation)?.turn ?? -1) + 1)
        conversation.messages.push(user)
      } else {
        user = conversation.messages.findLast((entry) => entry.role === 'user')
        if (!user || (!suffix.endsWith('/retry') && !suffix.endsWith(user.id)))
          return json({ error: 'Only latest user message is editable' }, 409)
        if (body.text !== undefined) user.text = body.text
        conversation.messages = conversation.messages.filter(
          (entry) => entry.turn < user.turn || entry.id === user.id,
        )
      }
      const generation = message('assistant', '', user.turn, body.preferences)
      conversation.messages.push(generation)
      if (conversation.title === 'New conversation') conversation.title = user.text.slice(0, 80)
      const admission = {
        userMessageId: user.id,
        generation: { ...generation },
        deduplicated: false,
      }
      conversation.admissions[body.requestId] = admission
      save()
      return json(admission, 202)
    }
    const generationMatch = suffix.match(/^\/generations\/([^/]+)(.*)$/)
    const generation =
      generationMatch &&
      conversation.messages.find((entry) => entry.generationId === generationMatch[1])
    if (generation) {
      const id = generation.generationId
      if (generationMatch[2] === '/cancel') {
        terminal(id, 'cancelled')
        return json(snapshot(conversation, generation))
      }
      if (!generationMatch[2]) return json(snapshot(conversation, generation))
      if (generationMatch[2] === '/events') {
        const after = Number(url.searchParams.get('after') || 0)
        let controller
        const stream = new ReadableStream({
          start(value) {
            controller = value
            for (const event of conversation.events[id] || [])
              if (event.id > after) value.enqueue(frame(event))
            if (['completed', 'cancelled', 'failed'].includes(generation.status)) value.close()
            else {
              const active = streams.get(id) || new Set()
              active.add(value)
              streams.set(id, active)
            }
          },
          cancel() {
            streams.get(id)?.delete(controller)
          },
        })
        init.signal?.addEventListener(
          'abort',
          () => {
            streams.get(id)?.delete(controller)
            try {
              controller.error(new DOMException('Aborted', 'AbortError'))
            } catch {
              /* Already closed. */
            }
          },
          { once: true },
        )
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
    }
    return json({ error: `Unconfigured fixture API: ${method} ${path}` }, 400)
  }
  // A generated tone exercises real recording/analyser APIs without device access.
  navigator.mediaDevices.getUserMedia = async () => {
    if (microphoneDenied) throw new DOMException('Simulated permission denial', 'NotAllowedError')
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const destination = context.createMediaStreamDestination()
    oscillator.connect(destination)
    oscillator.start()
    for (const track of destination.stream.getTracks()) {
      const stop = track.stop.bind(track)
      track.stop = () => {
        stop()
        oscillator.stop()
        void context.close()
      }
    }
    return destination.stream
  }
})()
