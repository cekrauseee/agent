import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { makeSignature } from 'better-auth/crypto'
import { getAuth } from '@agent/backend/auth'
import { getDb } from '@agent/backend/db'
import { conversations, messages } from '@agent/backend/db/schema'
import {
  deleteConversation,
  initialTitle,
  lockConversation,
  pagination,
  title,
  uuid,
} from '@agent/backend/organization'
import * as projectRoutes from '../app/api/projects/route'
import * as projectRoute from '../app/api/projects/[id]/route'
import * as conversationRoutes from '../app/api/conversations/route'
import * as conversationRoute from '../app/api/conversations/[id]/route'
import { GET as history } from '../app/api/conversations/[id]/messages/route'

test('organization input limits', () => {
  for (const value of [null, '', ' ', 'a'.repeat(201)]) assert.throws(() => title(value))
  for (const value of [null, 'bad', '../../private']) assert.throws(() => uuid(value))
  for (const limit of ['0', '101', '1.5', '-1', 'NaN'])
    assert.throws(() => pagination(new URLSearchParams({ limit })))
  assert.equal(initialTitle('  first\nmessage  '), 'first message')
  assert.equal(initialTitle(), 'New conversation')
  assert.equal(initialTitle('x'.repeat(300)).length, 200)
})

test(
  'owned metadata, project detach, ordered history reload and deletion',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
    const database = `organization_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${database}"`)
    url.pathname = `/${database}`
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      DATABASE_DRIVER: 'postgres',
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'organization-test-secret-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture',
    })
    const db = getDb()
    try {
      await migrate(db, { migrationsFolder })
      const auth = await getAuth().$context
      const a = await auth.internalAdapter.createUser(
        { name: 'A', email: 'a@example.test', emailVerified: true },
        { method: 'oauth', oauth: { providerId: 'google' } },
      )
      const b = await auth.internalAdapter.createUser(
        { name: 'B', email: 'b@example.test', emailVerified: true },
        { method: 'oauth', oauth: { providerId: 'google' } },
      )
      const cookies = await Promise.all(
        [a, b].map(async (owner) => {
          const session = await auth.internalAdapter.createSession(owner.id, false)
          assert.ok(session)
          return `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, process.env.BETTER_AUTH_SECRET!)}`)}`
        }),
      )
      const req = (
        path: string,
        method = 'GET',
        body?: unknown,
        actor = 0,
        origin = 'http://localhost:3000',
      ) =>
        new Request(`http://localhost:3000/api${path}`, {
          method,
          headers: { cookie: cookies[actor], origin, 'content-type': 'application/json' },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
      const context = (id: string) => ({ params: Promise.resolve({ id }) })
      const pResponse = await projectRoutes.POST(req('/projects', 'POST', { title: ' Project A ' }))
      assert.equal(pResponse.status, 201)
      const p = await pResponse.json()
      assert.equal(p.title, 'Project A')
      const p2 = await projectRoutes
        .POST(req('/projects', 'POST', { title: 'Project B' }))
        .then((r) => r.json())
      const foreign = await projectRoutes
        .POST(req('/projects', 'POST', { title: 'Private' }, 1))
        .then((r) => r.json())
      assert.equal(
        (await projectRoute.GET(req(`/projects/${p.id}`, 'GET', undefined, 1), context(p.id)))
          .status,
        404,
      )
      for (const method of ['PATCH', 'DELETE'] as const)
        assert.equal(
          (
            await projectRoute[method](
              req(
                `/projects/${p.id}`,
                method,
                method === 'PATCH' ? { title: 'stolen' } : undefined,
                1,
              ),
              context(p.id),
            )
          ).status,
          404,
        )
      assert.equal(
        (await projectRoutes.POST(req('/projects', 'POST', { title: 'bad', ownerId: b.id })))
          .status,
        400,
      )
      assert.equal(
        (
          await projectRoutes.POST(
            req('/projects', 'POST', { title: 'bad' }, 0, 'https://evil.test'),
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await projectRoute.PATCH(
            req(`/projects/${p.id}`, 'PATCH', { title: 'Renamed' }),
            context(p.id),
          )
        ).status,
        200,
      )
      const firstProjects = await projectRoutes.GET(req('/projects?limit=1')).then((r) => r.json())
      const nextProjects = await projectRoutes
        .GET(req(`/projects?limit=1&after=${firstProjects.nextCursor}`))
        .then((r) => r.json())
      assert.deepEqual([firstProjects.projects[0].id, nextProjects.projects[0].id], [p.id, p2.id])
      assert.equal(nextProjects.nextCursor, null)
      const chat = await conversationRoutes
        .POST(req('/conversations', 'POST', { projectId: p.id }))
        .then((r) => r.json())
      assert.equal(chat.title, 'New conversation')
      assert.equal(chat.projectId, p.id)
      const outside = await conversationRoutes
        .POST(req('/conversations', 'POST', { title: 'Outside' }))
        .then((r) => r.json())
      assert.equal(outside.projectId, null)
      assert.equal(
        (await conversationRoutes.POST(req('/conversations', 'POST', { projectId: foreign.id })))
          .status,
        404,
      )
      assert.equal(
        (
          await conversationRoute.PATCH(
            req(`/conversations/${chat.id}`, 'PATCH', { projectId: foreign.id }),
            context(chat.id),
          )
        ).status,
        404,
      )
      assert.equal(
        (
          await conversationRoute.PATCH(
            req(`/conversations/${chat.id}`, 'PATCH', { projectId: p2.id, title: 'Moved' }),
            context(chat.id),
          )
        ).status,
        200,
      )
      assert.equal(
        (
          await conversationRoute
            .GET(req(`/conversations/${chat.id}`), context(chat.id))
            .then((r) => r.json())
        ).projectId,
        p2.id,
      )
      assert.equal(
        (
          await conversationRoutes
            .GET(req(`/conversations?projectId=${p2.id}`))
            .then((r) => r.json())
        ).conversations.length,
        1,
      )
      assert.deepEqual(
        (
          await conversationRoutes.GET(req('/conversations?projectId=null')).then((r) => r.json())
        ).conversations.map((c: { id: string }) => c.id),
        [outside.id],
      )
      for (const method of ['GET', 'PATCH', 'DELETE'] as const)
        assert.equal(
          (
            await conversationRoute[method](
              req(
                `/conversations/${chat.id}`,
                method,
                method === 'PATCH' ? { title: 'stolen' } : undefined,
                1,
              ),
              context(chat.id),
            )
          ).status,
          404,
        )
      assert.equal(
        (
          await history(
            req(`/conversations/${chat.id}/messages`, 'GET', undefined, 1),
            context(chat.id),
          )
        ).status,
        404,
      )
      assert.equal(
        (await conversationRoutes.GET(req(`/conversations?after=${chat.id}`, 'GET', undefined, 1)))
          .status,
        404,
      )
      const [m0] = await db
        .insert(messages)
        .values({
          conversationId: chat.id,
          turn: 0,
          role: 'user',
          requestId: randomUUID(),
          text: 'First',
          contextBefore: [{ secret: 'internal' }],
        })
        .returning()
      const [m1] = await db
        .insert(messages)
        .values({
          conversationId: chat.id,
          turn: 0,
          role: 'assistant',
          requestId: randomUUID(),
          generationId: randomUUID(),
          generationVersion: 1,
          model: 'gpt-6-luna',
          effort: 'medium',
          text: 'Done',
          providerOutput: [{ secret: 'internal' }],
          citations: [
            { url: 'https://example.test', title: 'Source', secret: 'internal' },
            { url: 'javascript:alert(1)' },
          ],
        })
        .returning()
      const [m2] = await db
        .insert(messages)
        .values({
          conversationId: chat.id,
          turn: 1,
          role: 'user',
          requestId: randomUUID(),
          text: 'Latest',
        })
        .returning()
      const [m3] = await db
        .insert(messages)
        .values({
          conversationId: chat.id,
          turn: 1,
          role: 'assistant',
          requestId: randomUUID(),
          generationId: randomUUID(),
          generationVersion: 2,
          model: 'gpt-6.1-sol',
          effort: 'high',
          status: 'running',
          text: 'Partial',
          streamCursor: 5,
          providerResponseId: 'resp_private',
        })
        .returning()
      await db
        .update(conversations)
        .set({
          nextTurn: 2,
          generationVersion: 2,
          currentGenerationId: m3.generationId,
          providerResponseId: 'resp_before',
          context: [{ secret: 'internal' }],
        })
        .where(eq(conversations.id, chat.id))
      const snapshotResponse = await history(
        req(`/conversations/${chat.id}/messages?limit=2`),
        context(chat.id),
      )
      assert.equal(snapshotResponse.headers.get('cache-control'), 'private, no-store')
      const snapshot = await snapshotResponse.json()
      assert.deepEqual(
        snapshot.messages.map((m: { id: string }) => m.id),
        [m0.id, m1.id],
      )
      assert.equal(snapshot.lastEditableUserMessageId, m2.id)
      assert.equal(snapshot.currentGeneration.id, m3.id)
      assert.equal(snapshot.currentGeneration.text, 'Partial')
      assert.equal(snapshot.currentGeneration.status, 'running')
      assert.equal(snapshot.currentGeneration.effort, 'high')
      assert.equal(snapshot.currentGeneration.streamCursor, 5)
      assert.deepEqual(snapshot.messages[1].citations, [
        { type: 'url_citation', url: 'https://example.test', title: 'Source' },
      ])
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /resp_private|resp_before|internal|providerOutput|contextBefore/,
      )
      const next = await history(
        req(`/conversations/${chat.id}/messages?limit=2&after=${snapshot.nextCursor}`),
        context(chat.id),
      ).then((r) => r.json())
      assert.deepEqual(
        next.messages.map((m: { id: string }) => m.id),
        [m2.id, m3.id],
      )
      assert.equal(next.nextCursor, null)
      const afterUser = await history(
        req(`/conversations/${chat.id}/messages?limit=1&after=${m0.id}`),
        context(chat.id),
      ).then((r) => r.json())
      assert.equal(afterUser.messages[0].id, m1.id)
      assert.equal(
        (
          await history(
            req(`/conversations/${outside.id}/messages?after=${m0.id}`),
            context(outside.id),
          )
        ).status,
        404,
      )
      const reload = await conversationRoute
        .GET(req(`/conversations/${chat.id}`), context(chat.id))
        .then((r) => r.json())
      assert.deepEqual(reload.currentGeneration, snapshot.currentGeneration)
      assert.equal(
        (await projectRoute.DELETE(req(`/projects/${p2.id}`, 'DELETE'), context(p2.id))).status,
        200,
      )
      assert.equal(
        (
          await conversationRoute
            .GET(req(`/conversations/${chat.id}`), context(chat.id))
            .then((r) => r.json())
        ).projectId,
        null,
      )
      assert.equal(
        (
          await history(req(`/conversations/${chat.id}/messages`), context(chat.id)).then((r) =>
            r.json(),
          )
        ).messages.length,
        4,
      )
      const chats = await conversationRoutes
        .GET(req('/conversations?limit=1'))
        .then((r) => r.json())
      assert.equal(chats.conversations[0].id, chat.id)
      assert.equal(
        (
          await conversationRoutes
            .GET(req(`/conversations?after=${chats.nextCursor}&limit=1`))
            .then((r) => r.json())
        ).conversations[0].id,
        outside.id,
      )
      const receipt = await deleteConversation(a.id, chat.id)
      assert.deepEqual(receipt, {
        generationId: m3.generationId,
        providerResponseId: 'resp_private',
        status: 'running',
      })
      assert.equal(
        (await db.select().from(messages).where(eq(messages.conversationId, chat.id))).length,
        0,
      )
      await assert.rejects(
        db.transaction((tx) => lockConversation(tx, a.id, chat.id)),
        { status: 404 },
        'a stale writer cannot recreate a deleted conversation',
      )
      assert.equal(
        (await conversationRoute.GET(req(`/conversations/${chat.id}`), context(chat.id))).status,
        404,
      )
      assert.equal(
        (
          await conversationRoute.DELETE(
            req(`/conversations/${outside.id}`, 'DELETE'),
            context(outside.id),
          )
        ).status,
        200,
      )
      assert.equal(
        (await conversationRoute.GET(req('/conversations/bad'), context('bad'))).status,
        400,
      )
    } finally {
      const globalDb = globalThis as typeof globalThis & {
        agentDatabase?: { close: () => Promise<void> }
      }
      await globalDb.agentDatabase?.close()
      delete globalDb.agentDatabase
      process.env = saved
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
)
