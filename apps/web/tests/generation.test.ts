import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { makeSignature } from 'better-auth/crypto'
import { getAuth } from '@agent/backend/auth'
import { addEvent } from '@agent/backend/agent'
import { conversations, messages } from '@agent/backend/db/schema'
import { withTestDatabase } from '@agent/test-utils'
import { POST as postMessage } from '../app/api/conversations/[id]/messages/route'
import { PATCH as editMessage } from '../app/api/conversations/[id]/messages/[messageId]/route'
import { POST as retry } from '../app/api/conversations/[id]/generations/[generationId]/retry/route'
import { POST as cancel } from '../app/api/conversations/[id]/generations/[generationId]/cancel/route'
import { GET as state } from '../app/api/conversations/[id]/generations/[generationId]/route'
import { GET as events } from '../app/api/conversations/[id]/generations/[generationId]/events/route'
import { DELETE as remove } from '../app/api/conversations/[id]/route'

test(
  'generation routes preserve ownership, deduplication, SSE resume, edits and retries',
  { skip: !process.env.TEST_DATABASE_URL },
  async () =>
    withTestDatabase(async (db) => {
      Object.assign(process.env, {
        BETTER_AUTH_URL: 'http://localhost:3000',
        BETTER_AUTH_SECRET: 'web-generation-test-secret-at-least-32-characters',
        GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'fixture',
      })
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
      const [chat] = await db
        .insert(conversations)
        .values({ ownerId: actors[0].id, title: 'Route tests' })
        .returning()
      const body = { requestId: randomUUID(), text: 'First user' }
      const anonymous = new Request('http://localhost/api/messages', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
      })
      assert.equal((await postMessage(anonymous, context(chat.id))).status, 401)
      assert.equal(
        (await postMessage(req('/messages', 'POST', body, 1), context(chat.id))).status,
        404,
      )
      const [first, duplicate] = await Promise.all([
        postMessage(req('/messages', 'POST', body), context(chat.id)),
        postMessage(req('/messages', 'POST', body), context(chat.id)),
      ])
      assert.equal(first.status, 202)
      assert.equal(duplicate.status, 202)
      const accepted = await first.json()
      const generationId = accepted.generation.generationId
      assert.equal((await duplicate.json()).generation.generationId, generationId)
      for (const payload of [
        { ...body, text: 'Changed' },
        { requestId: randomUUID(), text: 'Concurrent' },
      ])
        assert.equal(
          (await postMessage(req('/messages', 'POST', payload), context(chat.id))).status,
          409,
        )
      const editContext = {
        params: Promise.resolve({ id: chat.id, messageId: accepted.userMessageId }),
      }
      assert.equal(
        (
          await editMessage(
            req('/edit', 'PATCH', { requestId: randomUUID(), text: 'Active' }),
            editContext,
          )
        ).status,
        409,
      )
      for (const route of [state, events])
        assert.equal(
          (await route(req('/foreign', 'GET', undefined, 1), context(chat.id, generationId)))
            .status,
          404,
        )
      for (const route of [retry, cancel])
        assert.equal(
          (
            await route(
              req('/foreign', 'POST', { requestId: randomUUID() }, 1),
              context(chat.id, generationId),
            )
          ).status,
          404,
        )
      assert.equal(
        (
          await editMessage(
            req('/edit', 'PATCH', { requestId: randomUUID(), text: 'Stolen' }, 1),
            editContext,
          )
        ).status,
        404,
      )
      const initial = await events(req('/events'), context(chat.id, generationId))
      const reader = initial.body!.getReader()
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/)
      await reader.cancel()
      const [assistant] = await db
        .select()
        .from(messages)
        .where(eq(messages.generationId, generationId))
      await db.transaction((tx) => addEvent(tx, assistant, 'text_delta', { delta: 'Hello' }))
      const partial = await (await state(req('/state'), context(chat.id, generationId))).json()
      const [completed] = await db
        .update(messages)
        .set({ text: 'Hello', status: 'completed', providerResponseId: 'resp_private' })
        .where(eq(messages.id, assistant.id))
        .returning()
      await db.transaction((tx) =>
        addEvent(tx, completed, 'completed', { text: 'Hello', status: 'completed' }),
      )
      const resumed = await (
        await events(req(`/events?after=${partial.eventCursor}`), context(chat.id, generationId))
      ).text()
      assert.match(resumed, /event: completed/)
      assert.doesNotMatch(resumed, /event: text_delta/)
      assert.equal(
        (await events(req('/events?after=2147483647'), context(chat.id, generationId))).status,
        409,
      )
      assert.doesNotMatch(
        JSON.stringify(await (await state(req('/state'), context(chat.id, generationId))).json()),
        /resp_private/,
      )
      const edited = await editMessage(
        req('/edit', 'PATCH', { requestId: randomUUID(), text: 'Replacement' }),
        editContext,
      )
      assert.equal(edited.status, 202)
      const replacement = await edited.json()
      assert.equal(replacement.userMessageId, accepted.userMessageId)
      const currentId = replacement.generation.generationId
      assert.equal((await cancel(req('/cancel', 'POST'), context(chat.id, currentId))).status, 200)
      const retriedResponse = await retry(
        req('/retry', 'POST', { requestId: randomUUID() }),
        context(chat.id, currentId),
      )
      assert.equal(retriedResponse.status, 202)
      assert.equal((await retriedResponse.json()).userMessageId, accepted.userMessageId)
      assert.equal((await remove(req('/delete', 'DELETE'), context(chat.id))).status, 200)
      assert.equal((await state(req('/deleted'), context(chat.id, currentId))).status, 404)
    }),
)
