import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { makeSignature } from 'better-auth/crypto'
import { getAuth } from '@agent/backend/auth'
import { getDb } from '@agent/backend/db'
import { markdown, MAX_MARKDOWN_BYTES, name } from '@agent/backend/spaces'
import { GET as directory } from '../app/api/space/route'
import { POST as createFolder } from '../app/api/folders/route'
import { POST as createPage } from '../app/api/pages/route'
import * as folderRoute from '../app/api/folders/[id]/route'
import * as pageRoute from '../app/api/pages/[id]/route'

test('space name and Markdown boundaries', () => {
  for (const value of [null, '', ' ', '.', '..', 'a/b', 'a\\b', 'a\n', 'a'.repeat(201), '\ud800'])
    assert.throws(() => name(value))
  assert.equal(name('  Name  '), 'Name')
  assert.equal(markdown(''), '')
  assert.equal(markdown('🦄'), '🦄')
  for (const value of [null, 42, 'a\0', '\ud800', '\udfff']) assert.throws(() => markdown(value))
  assert.equal(markdown('x'.repeat(MAX_MARKDOWN_BYTES)).length, MAX_MARKDOWN_BYTES)
  assert.throws(() => markdown('é'.repeat(MAX_MARKDOWN_BYTES / 2 + 1)), { status: 413 })
})

test(
  'signed-session private tree CRUD, serialized moves, content conflicts and subtree deletion',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
    const database = `spaces_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${database}"`)
    url.pathname = `/${database}`
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      DATABASE_DRIVER: 'postgres',
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'spaces-test-secret-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fixture',
    })
    try {
      await migrate(getDb(), { migrationsFolder })
      const auth = await getAuth().$context
      const cookies = await Promise.all(
        ['a', 'b'].map(async (label) => {
          const user = await auth.internalAdapter.createUser(
            { name: label, email: `${label}@example.test`, emailVerified: true },
            { method: 'oauth', oauth: { providerId: 'google' } },
          )
          const session = await auth.internalAdapter.createSession(user.id, false)
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
      const folder = async (body: unknown, actor = 0) => {
        const response = await createFolder(req('/folders', 'POST', body, actor))
        assert.equal(response.status, 201)
        return response.json()
      }
      const page = async (body: unknown, actor = 0) => {
        const response = await createPage(req('/pages', 'POST', body, actor))
        assert.equal(response.status, 201)
        return response.json()
      }
      const patchFolder = (id: string, body: unknown, actor = 0) =>
        folderRoute.PATCH(req(`/folders/${id}`, 'PATCH', body, actor), context(id))
      const patchPage = (id: string, body: unknown, actor = 0) =>
        pageRoute.PATCH(req(`/pages/${id}`, 'PATCH', body, actor), context(id))
      const root = await directory(req('/space')).then((r) => r.json())
      const other = await directory(req('/space', 'GET', undefined, 1)).then((r) => r.json())
      assert.notEqual(root.space.id, other.space.id)
      assert.deepEqual(root.folders, [])
      assert.deepEqual(root.pages, [])
      const f = await folder({ name: 'Root' })
      const nested = await folder({ name: 'Nested', parentId: f.id })
      const deep = await folder({ name: 'Deep', parentId: nested.id })
      const foreign = await folder({ name: 'Private' }, 1)
      const duplicate = await folder({ name: 'Root' })
      assert.notEqual(f.id, duplicate.id)
      const text = '  # Markdown\r\n\nUnicode: é 🦄\n```ts\nconst a = 1;\n```\n\t trailing  \n'
      let p = await page({ title: 'Readme', folderId: deep.id, markdown: text })
      const rootPage = await page({ title: 'Root page' })
      assert.equal(p.markdown, text)
      assert.equal(rootPage.markdown, '')
      assert.equal(
        (await pageRoute.GET(req(`/pages/${p.id}`), context(p.id)).then((r) => r.json())).markdown,
        text,
      )
      const listingResponse = await directory(req(`/space?parentId=${deep.id}`))
      assert.equal(listingResponse.headers.get('cache-control'), 'private, no-store')
      const listing = await listingResponse.json()
      assert.equal(listing.pages[0].id, p.id)
      assert.equal('markdown' in listing.pages[0], false)
      assert.equal((await directory(req(`/space?parentId=${foreign.id}`))).status, 404)
      for (const [route, id, patch] of [
        [folderRoute, f.id, { name: 'Stolen' }],
        [pageRoute, p.id, { markdown: 'Stolen', expectedUpdatedAt: p.updatedAt }],
      ] as const) {
        assert.equal(
          (await route.GET(req(`/items/${id}`, 'GET', undefined, 1), context(id))).status,
          404,
        )
        assert.equal(
          (await route.PATCH(req(`/items/${id}`, 'PATCH', patch, 1), context(id))).status,
          404,
        )
        assert.equal(
          (await route.DELETE(req(`/items/${id}`, 'DELETE', undefined, 1), context(id))).status,
          404,
        )
      }
      for (const parentId of [foreign.id, randomUUID()]) {
        assert.equal(
          (await createFolder(req('/folders', 'POST', { name: 'Invalid', parentId }))).status,
          404,
        )
        assert.equal(
          (await createPage(req('/pages', 'POST', { title: 'Invalid', folderId: parentId })))
            .status,
          404,
        )
        assert.equal((await patchFolder(f.id, { parentId })).status, 404)
        assert.equal(
          (await patchPage(p.id, { folderId: parentId, expectedUpdatedAt: p.updatedAt })).status,
          404,
        )
      }
      assert.equal((await patchFolder(f.id, { parentId: f.id })).status, 409)
      assert.equal((await patchFolder(f.id, { parentId: deep.id })).status, 409)
      assert.equal((await patchFolder(nested.id, { name: 'Renamed', parentId: null })).status, 200)
      assert.equal(
        (
          await folderRoute
            .GET(req(`/folders/${nested.id}`), context(nested.id))
            .then((r) => r.json())
        ).parentId,
        null,
      )
      assert.equal((await patchFolder(nested.id, { parentId: f.id })).status, 200)
      const x = await folder({ name: 'X' }),
        y = await folder({ name: 'Y' })
      const moves = await Promise.all([
        patchFolder(x.id, { parentId: y.id }),
        patchFolder(y.id, { parentId: x.id }),
      ])
      assert.deepEqual(moves.map((r) => r.status).sort(), [200, 409])
      const edits = await Promise.all([
        patchPage(p.id, { markdown: 'first', expectedUpdatedAt: p.updatedAt }),
        patchPage(p.id, { markdown: 'second', expectedUpdatedAt: p.updatedAt }),
      ])
      assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409])
      p = await edits.find((r) => r.status === 200)!.json()
      const moved = await patchPage(p.id, {
        title: 'Renamed page',
        folderId: null,
        markdown: text,
        expectedUpdatedAt: p.updatedAt,
      })
      assert.equal(moved.status, 200)
      const movedPage = await moved.json()
      assert.notEqual(movedPage.updatedAt, p.updatedAt)
      assert.equal(movedPage.folderId, null)
      assert.equal(movedPage.markdown, text)
      assert.equal(
        (await patchPage(p.id, { markdown: 'stale', expectedUpdatedAt: p.updatedAt })).status,
        409,
      )
      assert.equal((await patchPage(p.id, { markdown: 'missing precondition' })).status, 400)
      assert.equal(
        (await patchPage(p.id, { folderId: deep.id, expectedUpdatedAt: movedPage.updatedAt }))
          .status,
        200,
      )
      const rootListing = await directory(req('/space?limit=1')).then((r) => r.json())
      assert.equal(rootListing.folders.length, 1)
      assert.ok(rootListing.nextFolderCursor)
      const nextListing = await directory(
        req(`/space?limit=1&folderAfter=${rootListing.nextFolderCursor}`),
      ).then((r) => r.json())
      assert.notEqual(nextListing.folders[0].id, rootListing.folders[0].id)
      const secondRootPage = await page({ title: 'Another root page' })
      const pageListing = await directory(req('/space?limit=1')).then((r) => r.json())
      const nextPageListing = await directory(
        req(`/space?limit=1&pageAfter=${pageListing.nextPageCursor}`),
      ).then((r) => r.json())
      assert.deepEqual(
        [pageListing.pages[0].id, nextPageListing.pages[0].id].sort(),
        [rootPage.id, secondRootPage.id].sort(),
      )
      assert.equal((await directory(req(`/space?folderAfter=${foreign.id}`))).status, 404)
      assert.equal((await directory(req(`/space?folderAfter=${deep.id}`))).status, 400)
      assert.equal((await directory(req(`/space?pageAfter=${p.id}`))).status, 400)
      assert.equal(
        (await createFolder(req('/folders', 'POST', { name: 'Owner', ownerId: 'b' }))).status,
        400,
      )
      assert.equal(
        (await createFolder(req('/folders', 'POST', { name: 'Origin' }, 0, 'https://evil.test')))
          .status,
        403,
      )
      assert.equal((await directory(new Request('http://localhost:3000/api/space'))).status, 401)
      assert.equal(
        (
          await createPage(
            req('/pages', 'POST', { title: 'Large', markdown: 'x'.repeat(MAX_MARKDOWN_BYTES + 1) }),
          )
        ).status,
        413,
      )
      const doomed = await folder({ name: 'Delete race' })
      const deletionRace = await Promise.all([
        folderRoute.DELETE(req(`/folders/${doomed.id}`, 'DELETE'), context(doomed.id)),
        createPage(req('/pages', 'POST', { title: 'Racing page', folderId: doomed.id })),
      ])
      assert.equal(deletionRace[0].status, 200)
      assert.ok([201, 404].includes(deletionRace[1].status))
      if (deletionRace[1].status === 201) {
        const racingPage = await deletionRace[1].json()
        assert.equal(
          (await pageRoute.GET(req(`/pages/${racingPage.id}`), context(racingPage.id))).status,
          404,
        )
      }
      assert.equal(
        (await folderRoute.DELETE(req(`/folders/${f.id}`, 'DELETE'), context(f.id))).status,
        200,
      )
      for (const id of [f.id, nested.id, deep.id])
        assert.equal((await folderRoute.GET(req(`/folders/${id}`), context(id))).status, 404)
      assert.equal((await pageRoute.GET(req(`/pages/${p.id}`), context(p.id))).status, 404)
      assert.equal(
        (await pageRoute.GET(req(`/pages/${rootPage.id}`), context(rootPage.id))).status,
        200,
      )
      assert.equal(
        (await pageRoute.DELETE(req(`/pages/${rootPage.id}`, 'DELETE'), context(rootPage.id)))
          .status,
        200,
      )
      assert.equal(
        (await pageRoute.GET(req(`/pages/${rootPage.id}`), context(rootPage.id))).status,
        404,
      )
      assert.equal(
        (await directory(req('/space', 'GET', undefined, 1)).then((r) => r.json())).folders[0].id,
        foreign.id,
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
