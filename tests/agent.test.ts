import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import OpenAI from 'openai'
import type {
  Response as ModelResponse,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'
import { Pool } from 'pg'
import { and, count, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { makeSignature } from 'better-auth/crypto'
import { getAuth } from '@agent/backend/auth'
import { createDatabase, getDb } from '@agent/backend/db'
import {
  conversations,
  generationEvents,
  generationJobs,
  messages,
  paidRequests,
  user,
} from '@agent/backend/db/schema'
import {
  messageText,
  submitTurn,
  getGeneration,
  readEvents,
  cancelGeneration,
} from '@agent/backend/agent'
import { reconcile, replayContext, saveEvent, saveResponse } from '../apps/worker/src/worker'
import { eventCursor } from '@agent/backend/agent/stream'
import { reservePaid, releasePaid, withPaidRequest } from '@agent/backend/server/openai'
import { POST as postMessage } from '../apps/web/app/api/conversations/[id]/messages/route'
import { PATCH as editMessage } from '../apps/web/app/api/conversations/[id]/messages/[messageId]/route'
import { POST as retry } from '../apps/web/app/api/conversations/[id]/generations/[generationId]/retry/route'
import { POST as cancelRoute } from '../apps/web/app/api/conversations/[id]/generations/[generationId]/cancel/route'
import { GET as state } from '../apps/web/app/api/conversations/[id]/generations/[generationId]/route'
import { GET as streamRoute } from '../apps/web/app/api/conversations/[id]/generations/[generationId]/events/route'
import { DELETE as deleteRoute } from '../apps/web/app/api/conversations/[id]/route'

const citation = {
  type: 'url_citation',
  url: 'https://example.test/source',
  title: 'Source',
  start_index: 0,
  end_index: 5,
}
const output = (text: string, compaction?: string) => [
  { type: 'reasoning', id: `rs_${text}`, summary: [], encrypted_content: 'opaque-reasoning' },
  {
    type: 'message',
    id: `msg_${text}`,
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [citation], logprobs: [] }],
  },
  ...(compaction
    ? [{ type: 'compaction', id: `cmp_${compaction}`, encrypted_content: compaction }]
    : []),
]
const providerResponse = (
  id: string,
  status = 'in_progress',
  text = 'Hello world',
  compact?: string,
) => ({
  id,
  object: 'response',
  created_at: 1,
  status,
  output: status === 'in_progress' ? [] : output(text, compact),
  usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
})
const event = (type: string, sequence_number: number, data: Record<string, unknown> = {}) => ({
  type,
  sequence_number,
  ...data,
})
function controlledProvider() {
  const calls: {
    method: string
    path: string
    query: URLSearchParams
    body?: Record<string, unknown>
  }[] = []
  const responses = new Map<string, ReturnType<typeof providerResponse>>()
  const cancelled: string[] = []
  const deleted: string[] = []
  let rejectNext = false
  let ambiguousNext = false
  let expirePrevious = false
  let cleanupFailure = false
  let beforeCreated: (() => Promise<void>) | undefined
  const client = new OpenAI({
    apiKey: 'test-only',
    maxRetries: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, path: url.pathname, query: url.searchParams, body })
      const sse = (events: unknown[]) =>
        new Response(
          events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      if (url.pathname === '/v1/responses' && method === 'POST') {
        if (ambiguousNext) {
          ambiguousNext = false
          throw new Error('Transport disconnected before ID')
        }
        if (rejectNext) {
          rejectNext = false
          return Response.json(
            { error: { message: 'Fixture rejection', code: 'unsupported_model' } },
            { status: 400 },
          )
        }
        if (expirePrevious && body?.previous_response_id) {
          expirePrevious = false
          return Response.json(
            {
              error: {
                message: 'Previous missing',
                param: 'previous_response_id',
                code: 'previous_response_not_found',
              },
            },
            { status: 404 },
          )
        }
        const id = `resp_${randomUUID()}`
        const response = providerResponse(id)
        responses.set(id, response)
        if (beforeCreated) {
          const callback = beforeCreated
          beforeCreated = undefined
          await callback()
        }
        return sse([event('response.created', 0, { response })])
      }
      const id = url.pathname.split('/')[3]
      if (url.pathname.endsWith('/cancel')) {
        if (cleanupFailure)
          return Response.json({ error: { message: 'temporary cleanup failure' } }, { status: 503 })
        cancelled.push(id)
        return Response.json(providerResponse(id, 'cancelled'))
      }
      if (method === 'DELETE') {
        deleted.push(id)
        responses.delete(id)
        return new Response(null, { status: 204 })
      }
      const response = responses.get(id)
      if (!response) return Response.json({ error: { message: 'missing' } }, { status: 404 })
      if (url.searchParams.get('stream') === 'true') {
        const after = Number(url.searchParams.get('starting_after'))
        return sse(
          [
            event('response.output_text.delta', 2, {
              delta: 'Hello ',
              output_index: 0,
              content_index: 0,
              item_id: 'msg',
            }),
            event('response.output_text.delta', 3, {
              delta: 'world',
              output_index: 0,
              content_index: 0,
              item_id: 'msg',
            }),
            event('response.output_text.annotation.added', 4, {
              annotation: citation,
              output_index: 0,
              content_index: 0,
              annotation_index: 0,
              item_id: 'msg',
            }),
          ].filter((value) => value.sequence_number > after),
        )
      }
      return Response.json(response)
    },
  })
  return {
    client,
    calls,
    responses,
    cancelled,
    deleted,
    reject() {
      rejectNext = true
    },
    ambiguous() {
      ambiguousNext = true
    },
    expire() {
      expirePrevious = true
    },
    cleanupFails(value: boolean) {
      cleanupFailure = value
    },
    beforeCreate(callback: () => Promise<void>) {
      beforeCreated = callback
    },
  }
}

test('message/cursor bounds and installed SDK compaction/phase conversion', () => {
  for (const text of ['', ' ', null, '\0', '\ud800', 'x'.repeat(65_537)])
    assert.throws(() => messageText(text))
  assert.equal(messageText('  original language\n'), '  original language\n')
  for (const cursor of ['-1', '1.5', 'bad', '2147483648'])
    assert.throws(() => eventCursor(new Request(`http://localhost/events?after=${cursor}`)))
  const items = replayContext([
    { role: 'user', content: 'discard-before-compaction' },
    ...output('answer', 'opaque'),
  ])
  assert.equal(items.length, 1)
  assert.equal((items[0] as { encrypted_content: string }).encrypted_content, 'opaque')
  const converted = replayContext(output('answer'))
  assert.equal((converted[1] as { phase: string }).phase, 'final_answer')
  assert.equal(
    (converted[0] as { encrypted_content: string }).encrypted_content,
    'opaque-reasoning',
  )
})

test(
  'background execution, reconnect, restart, context isolation and paid controls with PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
    const name = `agent_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${name}"`)
    url.pathname = `/${name}`
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      DATABASE_DRIVER: 'postgres',
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'agent-test-secret-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture',
    })
    const db = getDb()
    const remote = controlledProvider()
    const actorClient = remote.client
    try {
      await migrate(db, { migrationsFolder })
      const auth = await getAuth().$context
      const actors = await Promise.all(
        ['A', 'B'].map((name) =>
          auth.internalAdapter.createUser(
            { name, email: `${name}@example.test`, emailVerified: true },
            { method: 'oauth', oauth: { providerId: 'google' } },
          ),
        ),
      )
      const cookies = await Promise.all(
        actors.map(async (actor) => {
          const session = await auth.internalAdapter.createSession(actor.id, false)
          assert.ok(session)
          return `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, process.env.BETTER_AUTH_SECRET!)}`)}`
        }),
      )
      const req = (path: string, method = 'GET', body?: unknown, actor = 0) =>
        new Request(`http://localhost:3000/api${path}`, {
          method,
          headers: {
            cookie: cookies[actor],
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      const context = (id: string, generationId = '') => ({
        params: Promise.resolve({ id, generationId }),
      })
      const chat = async () =>
        (
          await db
            .insert(conversations)
            .values({ ownerId: actors[0].id, title: 'New conversation' })
            .returning()
        )[0]
      const clearRate = async () => {
        await db.update(paidRequests).set({ createdAt: sql`now() - interval '2 minutes'` })
      }
      const start = async (id: string, text: string) =>
        submitTurn(actors[0].id, id, { requestId: randomUUID(), text }, { kind: 'start' }, db)
      const stored = async (generationId: string) =>
        (await db.select().from(messages).where(eq(messages.generationId, generationId)))[0]
      const first = await chat()
      const body = { requestId: randomUUID(), text: 'Original first user' }
      assert.equal(
        (
          await postMessage(
            new Request(`http://localhost/api/conversations/${first.id}/messages`, {
              method: 'POST',
              headers: { origin: 'http://localhost:3000' },
            }),
            context(first.id),
          )
        ).status,
        401,
      )
      assert.equal(
        (
          await postMessage(
            req(`/conversations/${first.id}/messages`, 'POST', body, 1),
            context(first.id),
          )
        ).status,
        404,
      )
      assert.equal(remote.calls.length, 0)
      const [a, b] = await Promise.all([
        postMessage(req(`/conversations/${first.id}/messages`, 'POST', body), context(first.id)),
        postMessage(req(`/conversations/${first.id}/messages`, 'POST', body), context(first.id)),
      ])
      assert.equal(a.status, 202)
      assert.equal(b.status, 202)
      const accepted = await a.json()
      const duplicate = await b.json()
      const generationId = accepted.generation.generationId
      assert.equal(duplicate.generation.generationId, generationId)
      assert.equal((await db.select({ n: count() }).from(messages))[0].n, 2)
      assert.equal(
        (
          await postMessage(
            req(`/conversations/${first.id}/messages`, 'POST', { ...body, text: 'Conflict' }),
            context(first.id),
          )
        ).status,
        409,
      )
      assert.equal(
        (
          await postMessage(
            req(`/conversations/${first.id}/messages`, 'POST', {
              requestId: randomUUID(),
              text: 'Simultaneous',
            }),
            context(first.id),
          )
        ).status,
        409,
      )
      assert.equal(
        (
          await editMessage(
            req('/edit', 'PATCH', { requestId: randomUUID(), text: 'while active' }),
            { params: Promise.resolve({ id: first.id, messageId: accepted.userMessageId }) },
          )
        ).status,
        409,
      )
      for (const route of [state, streamRoute])
        assert.equal(
          (await route(req('/state', 'GET', undefined, 1), context(first.id, generationId))).status,
          404,
        )
      for (const route of [retry, cancelRoute])
        assert.equal(
          (
            await route(
              req('/foreign', 'POST', { requestId: randomUUID() }, 1),
              context(first.id, generationId),
            )
          ).status,
          404,
        )
      assert.equal(
        (
          await editMessage(
            req('/foreign', 'PATCH', { requestId: randomUUID(), text: 'stolen' }, 1),
            { params: Promise.resolve({ id: first.id, messageId: accepted.userMessageId }) },
          )
        ).status,
        404,
      )
      const initial = await streamRoute(req('/stream'), context(first.id, generationId))
      const reader = initial.body!.getReader()
      const initialFrame = new TextDecoder().decode((await reader.read()).value)
      assert.match(initialFrame, /event: snapshot/)
      await reader.cancel()
      await reconcile(actorClient, db)
      const row = await stored(generationId)
      assert.ok(row.providerResponseId)
      assert.equal(row.status, 'running')
      const createCall = remote.calls.find(
        (call) => call.method === 'POST' && call.path === '/v1/responses',
      )!
      assert.equal(createCall.body?.model, 'gpt-6-luna')
      assert.deepEqual(createCall.body?.reasoning, { effort: 'medium' })
      assert.equal(createCall.body?.instructions, 'you are a helpful assistant')
      assert.deepEqual(createCall.body?.tools, [{ type: 'web_search' }])
      assert.equal(createCall.body?.tool_choice, 'auto')
      assert.equal(createCall.body?.background, true)
      assert.equal(createCall.body?.stream, true)
      assert.equal(createCall.body?.store, true)
      assert.equal(createCall.body?.max_tool_calls, 5)
      assert.equal(createCall.body?.max_output_tokens, 16_384)
      assert.deepEqual(createCall.body?.context_management, [
        { type: 'compaction', compact_threshold: 100_000 },
      ])
      await db
        .update(user)
        .set({ preferredModel: 'gpt-6.1-sol', preferredEffort: 'high' })
        .where(eq(user.id, actors[0].id))
      await reconcile(actorClient, db) // No HTTP client remains; worker stores streamed deltas/citations.
      const partial = await getGeneration(actors[0].id, first.id, generationId, db)
      assert.equal(partial.text, 'Hello world')
      assert.equal(partial.status, 'running')
      assert.equal(partial.citations.length, 1)
      assert.equal(partial.model, 'gpt-6-luna')
      const eventRows = await readEvents(actors[0].id, first.id, generationId, 0, db)
      assert.equal(
        eventRows.events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.data.delta)
          .join(''),
        'Hello world',
      )
      const beforeRepeat = eventRows.events.length
      await saveEvent(
        generationId,
        event('response.output_text.delta', 3, {
          delta: 'duplicate',
          output_index: 0,
          content_index: 0,
          item_id: 'msg',
        }) as ResponseStreamEvent,
        db,
      )
      assert.equal(
        (await readEvents(actors[0].id, first.id, generationId, 0, db)).events.length,
        beforeRepeat,
      )
      // Worker restart is a fresh database pool/client; no in-memory generation state carries over.
      const restarted = createDatabase({ driver: 'postgres', url: url.href })
      await reconcile(actorClient, restarted.db)
      await restarted.close()
      assert.ok(remote.calls.some((call) => call.query.get('starting_after') === '4'))
      assert.equal(
        remote.calls.filter((call) => call.method === 'POST' && call.path === '/v1/responses')
          .length,
        1,
      )
      remote.responses.set(
        row.providerResponseId!,
        providerResponse(
          row.providerResponseId!,
          'completed',
          'Original first answer',
          'old-first-compaction',
        ),
      )
      await reconcile(actorClient, db) // Persist final while still no client.
      const completed = await getGeneration(actors[0].id, first.id, generationId, db)
      assert.equal(completed.status, 'completed')
      assert.equal(completed.text, 'Original first answer')
      const afterDisconnect = await streamRoute(
        req(`/events?after=${partial.eventCursor}`),
        context(first.id, generationId),
      )
      const resumed = await afterDisconnect.text()
      assert.match(resumed, /event: completed/)
      assert.doesNotMatch(resumed, /event: text_delta/)
      assert.equal(
        (await streamRoute(req('/events?after=2147483647'), context(first.id, generationId)))
          .status,
        409,
      )
      const internal = await stored(generationId)
      assert.equal((internal.providerOutput?.[1] as { phase: string }).phase, 'final_answer')
      assert.deepEqual(internal.usage, { input_tokens: 4, output_tokens: 3, total_tokens: 7 })
      assert.doesNotMatch(JSON.stringify(completed), /opaque|old-first-compaction|resp_/)
      // First-turn replacement must restore EMPTY context, without its old compaction.
      const replaced = await submitTurn(
        actors[0].id,
        first.id,
        { requestId: randomUUID(), text: 'Replacement first user' },
        { kind: 'replace', targetId: accepted.userMessageId },
        db,
      )
      assert.equal(replaced.userMessageId, accepted.userMessageId)
      assert.notEqual(replaced.generation.generationId, generationId)
      assert.equal(await stored(generationId), undefined)
      await saveResponse(
        generationId,
        providerResponse(row.providerResponseId!, 'completed', 'late discarded') as ModelResponse,
        db,
      )
      assert.equal(await stored(generationId), undefined)
      await reconcile(actorClient, db)
      const newRow = await stored(replaced.generation.generationId!)
      const replacementCall = remote.calls
        .filter((call) => call.path === '/v1/responses' && call.method === 'POST')
        .at(-1)!
      assert.deepEqual(replacementCall.body?.input, [
        { role: 'user', content: 'Replacement first user' },
      ])
      assert.equal(replacementCall.body?.previous_response_id, undefined)
      assert.equal(replacementCall.body?.model, 'gpt-6.1-sol')
      assert.deepEqual(replacementCall.body?.reasoning, { effort: 'high' })
      assert.ok(remote.cancelled.includes(row.providerResponseId!))
      assert.ok(remote.deleted.includes(row.providerResponseId!))
      remote.responses.set(
        newRow.providerResponseId!,
        providerResponse(
          newRow.providerResponseId!,
          'completed',
          'Kept first answer',
          'valid-compaction',
        ),
      )
      await reconcile(actorClient, db)
      // Expired continuation falls back to the latest valid compaction and new input.
      const second = await start(first.id, 'Original latest user')
      remote.expire()
      await reconcile(actorClient, db)
      const continuationCalls = remote.calls
        .filter((call) => call.path === '/v1/responses' && call.method === 'POST')
        .slice(-2)
      assert.equal(continuationCalls[0].body?.previous_response_id, newRow.providerResponseId)
      const fallback = continuationCalls[1].body?.input
      assert.deepEqual(fallback, [
        { type: 'compaction', id: 'cmp_valid-compaction', encrypted_content: 'valid-compaction' },
        { role: 'user', content: 'Original latest user' },
      ])
      const secondRow = await stored(second.generation.generationId!)
      remote.responses.set(
        secondRow.providerResponseId!,
        providerResponse(
          secondRow.providerResponseId!,
          'completed',
          'Original latest answer',
          'invalid-latest-compaction',
        ),
      )
      await reconcile(actorClient, db)
      await assert.rejects(
        submitTurn(
          actors[0].id,
          first.id,
          { requestId: randomUUID(), text: 'Older edit' },
          { kind: 'replace', targetId: accepted.userMessageId },
          db,
        ),
        /Only the latest/,
      )
      await clearRate()
      const editedSecond = await submitTurn(
        actors[0].id,
        first.id,
        { requestId: randomUUID(), text: 'New latest user' },
        { kind: 'replace', targetId: second.userMessageId },
        db,
      )
      await saveResponse(
        second.generation.generationId!,
        providerResponse(
          secondRow.providerResponseId!,
          'completed',
          'stale answer',
        ) as ModelResponse,
        db,
      )
      await reconcile(actorClient, db)
      const editCall = remote.calls
        .filter((call) => call.path === '/v1/responses' && call.method === 'POST')
        .at(-1)!
      assert.equal(editCall.body?.previous_response_id, newRow.providerResponseId)
      assert.deepEqual(editCall.body?.input, [{ role: 'user', content: 'New latest user' }])
      const activeRow = await stored(editedSecond.generation.generationId!)
      assert.doesNotMatch(JSON.stringify(activeRow.contextBefore), /Original latest|invalid-latest/)
      assert.equal(
        (
          await db
            .select({ n: count() })
            .from(generationEvents)
            .where(eq(generationEvents.messageId, secondRow.id))
        )[0].n,
        0,
      )
      // Explicit cancellation is different from disconnect; retry keeps one user identity.
      await cancelGeneration(actors[0].id, first.id, activeRow.generationId!, db)
      const retryBody = { requestId: randomUUID() }
      const retriedResponse = await retry(
        req('/retry', 'POST', retryBody),
        context(first.id, activeRow.generationId!),
      )
      assert.equal(retriedResponse.status, 202)
      const retried = await retriedResponse.json()
      assert.equal(retried.userMessageId, second.userMessageId)
      await saveResponse(
        activeRow.generationId!,
        providerResponse(
          activeRow.providerResponseId!,
          'completed',
          'cancelled late',
        ) as ModelResponse,
        db,
      )
      await reconcile(actorClient, db)
      const retriedRow = await stored(retried.generation.generationId)
      remote.responses.set(
        retriedRow.providerResponseId!,
        providerResponse(retriedRow.providerResponseId!, 'incomplete', 'Partial only'),
      )
      await reconcile(actorClient, db)
      assert.equal((await stored(retried.generation.generationId)).status, 'failed')
      assert.equal((await stored(retried.generation.generationId)).error, 'incomplete_response')
      assert.doesNotMatch(
        JSON.stringify(
          (await db.select().from(conversations).where(eq(conversations.id, first.id)))[0].context,
        ),
        /Partial only/,
      )
      // Failed creation retries explicitly; ambiguous creation is not automatically paid twice.
      await clearRate()
      const failedChat = await chat()
      const failed = await start(failedChat.id, 'retry text')
      remote.reject()
      await reconcile(actorClient, db)
      assert.equal((await stored(failed.generation.generationId!)).error, 'provider_rejected')
      const recovered = await submitTurn(
        actors[0].id,
        failedChat.id,
        { requestId: randomUUID() },
        { kind: 'retry', targetId: failed.generation.generationId! },
        db,
      )
      assert.equal(recovered.userMessageId, failed.userMessageId)
      remote.ambiguous()
      await reconcile(actorClient, db)
      assert.equal((await stored(recovered.generation.generationId!)).error, 'ambiguous_creation')
      const countBefore = remote.calls.length
      await reconcile(actorClient, db)
      assert.equal(remote.calls.length, countBefore)
      // Simulated process death after claim but before provider ID: recover as ambiguous, do not resubmit.
      const crashChat = await chat()
      const crashed = await start(crashChat.id, 'crash')
      await db
        .update(generationJobs)
        .set({ state: 'creating', leaseUntil: sql`now() - interval '1 minute'` })
        .where(eq(generationJobs.id, crashed.generation.generationId!))
      const createCount = remote.calls.filter((call) => call.path === '/v1/responses').length
      await reconcile(actorClient, db)
      assert.equal((await stored(crashed.generation.generationId!)).error, 'ambiguous_creation')
      assert.equal(remote.calls.filter((call) => call.path === '/v1/responses').length, createCount)
      // Deletion DURING creation leaves only a cleanup job; late callbacks cannot resurrect history.
      await clearRate()
      const deletedChat = await chat()
      const deleting = await start(deletedChat.id, 'delete race')
      remote.beforeCreate(async () => {
        assert.equal(
          (await deleteRoute(req('/delete', 'DELETE'), context(deletedChat.id))).status,
          200,
        )
      })
      await reconcile(actorClient, db)
      assert.equal(await stored(deleting.generation.generationId!), undefined)
      const cleanupJob = (
        await db
          .select()
          .from(generationJobs)
          .where(eq(generationJobs.id, deleting.generation.generationId!))
      )[0]
      assert.ok(cleanupJob.cleanup)
      assert.ok(cleanupJob.providerResponseId)
      remote.cleanupFails(true)
      await reconcile(actorClient, db)
      assert.equal(
        (await db.select().from(generationJobs).where(eq(generationJobs.id, cleanupJob.id))).length,
        1,
      )
      remote.cleanupFails(false)
      await reconcile(actorClient, db)
      assert.ok(remote.cancelled.includes(cleanupJob.providerResponseId!))
      assert.ok(remote.deleted.includes(cleanupJob.providerResponseId!))
      assert.equal(
        (await db.select().from(generationJobs).where(eq(generationJobs.id, cleanupJob.id))).length,
        0,
      )
      assert.equal(
        (await state(req('/deleted'), context(deletedChat.id, deleting.generation.generationId!)))
          .status,
        404,
      )
      // Competing distinct submissions serialize; one accepts, one conflicts.
      const competingChat = await chat()
      const competing = await Promise.allSettled([
        start(competingChat.id, 'one'),
        start(competingChat.id, 'two'),
      ])
      assert.equal(competing.filter((value) => value.status === 'fulfilled').length, 1)
      assert.equal(competing.filter((value) => value.status === 'rejected').length, 1)
      // Shared paid controls apply to transcription too and release on failure.
      await clearRate()
      await assert.rejects(
        withPaidRequest(
          actors[1].id,
          'transcription',
          async () => {
            throw new Error('audio failed')
          },
          db,
        ),
        /audio failed/,
      )
      const [audio] = await db
        .select({ released: sql<boolean>`${paidRequests.activeUntil} <= now()` })
        .from(paidRequests)
        .where(eq(paidRequests.ownerId, actors[1].id))
      assert.equal(audio.released, true)
      for (let i = 0; i < 9; i++)
        await withPaidRequest(actors[1].id, 'transcription', async () => 'text', db)
      await assert.rejects(
        withPaidRequest(actors[1].id, 'transcription', async () => 'blocked', db),
        /Paid request limit/,
      )
      await db.delete(paidRequests)
      const slots = [randomUUID(), randomUUID(), randomUUID()]
      for (const slot of slots)
        await db.transaction((tx) => reservePaid(actors[1].id, slot, 'transcription', tx))
      let attempted = false
      await assert.rejects(
        withPaidRequest(
          actors[1].id,
          'transcription',
          async () => {
            attempted = true
          },
          db,
        ),
        /Paid request limit/,
      )
      assert.equal(attempted, false)
      for (const slot of slots) await releasePaid(slot, db)
      await db.delete(paidRequests)
      await db.insert(paidRequests).values(
        Array.from({ length: 20 }, () => ({
          id: randomUUID(),
          ownerId: actors[0].id,
          kind: 'fixture',
          activeUntil: new Date(Date.now() + 60_000),
        })),
      )
      await assert.rejects(
        withPaidRequest(actors[1].id, 'transcription', async () => 'blocked globally', db),
        /Paid request limit/,
      )
      const allBodies = remote.calls
        .filter((call) => call.path === '/v1/responses' && call.method === 'POST')
        .map((call) => call.body!)
      assert.ok(
        allBodies.every(
          (body) =>
            body.instructions === 'you are a helpful assistant' &&
            JSON.stringify(body.tools) === '[{"type":"web_search"}]',
        ),
      )
      assert.equal(
        (
          await db
            .select({ n: count() })
            .from(messages)
            .where(and(eq(messages.conversationId, first.id), eq(messages.role, 'user')))
        )[0].n,
        2,
      )
    } finally {
      const globalDb = globalThis as typeof globalThis & {
        agentDatabase?: ReturnType<typeof createDatabase>
      }
      await globalDb.agentDatabase?.close()
      delete globalDb.agentDatabase
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      await admin.end()
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  },
)
