import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { makeSignature } from 'better-auth/crypto'
import {
  authOrigin,
  createAuth,
  ensureSpace,
  getAuth,
  googleProfile,
  requireOwner,
  requireOrigin,
} from '@agent/backend/auth'
import { getDb } from '@agent/backend/db'
import { spaces, user, session } from '@agent/backend/db/schema'
import {
  DEFAULT_PREFERENCES,
  effectivePreferences,
  validatePreferences,
} from '@agent/backend/models'
import { readJson, ApiError } from '@agent/backend/server/http'
import { GET as me } from '../app/api/me/route'
import { GET as preferences, PATCH as update } from '../app/api/me/preferences/route'
import { GET as models } from '../app/api/models/route'
import { GET as authGET, POST as authPOST } from '../app/api/auth/[...all]/route'

test('profile mapping, strict preferences, origins and bounded JSON', async () => {
  assert.deepEqual(googleProfile({ name: 'Single Display Name', email: 'a@example.test' }), {
    name: 'Single Display Name',
    firstName: null,
    lastName: null,
    email: 'a@example.test',
    image: undefined,
  })
  assert.equal(
    googleProfile({ given_name: 'Given', family_name: 'Family', email: 'a@example.test' }).lastName,
    'Family',
  )
  assert.equal(googleProfile({ email: 'a@example.test' }).name, 'a@example.test')
  assert.deepEqual(
    effectivePreferences({ preferredModel: null, preferredEffort: null }),
    DEFAULT_PREFERENCES,
  )
  for (const input of [
    null,
    [],
    {},
    { model: 'arbitrary', effort: 'medium' },
    { model: 'gpt-6.1-sol', effort: 'none' },
    { model: 'gpt-6-luna', effort: 'ultra' },
    { model: 'gpt-6-luna', effort: 'medium', ownerId: 'other' },
  ]) {
    assert.throws(() => validatePreferences(input))
  }
  assert.deepEqual(validatePreferences({ model: 'gpt-6-luna', effort: 'none' }), {
    model: 'gpt-6-luna',
    effort: 'none',
  })
  const saved = process.env.BETTER_AUTH_URL
  try {
    process.env.BETTER_AUTH_URL = 'https://app.example.test'
    assert.equal(authOrigin(), 'https://app.example.test')
    for (const origin of [
      undefined,
      'null',
      'https://evil.example.test',
      'https://app.example.test.evil.test',
    ]) {
      assert.throws(
        () =>
          requireOrigin(
            new Request('https://app.example.test/api', {
              method: 'POST',
              headers: origin ? { origin } : {},
            }),
          ),
        ApiError,
      )
    }
    requireOrigin(
      new Request('https://app.example.test/api', {
        method: 'POST',
        headers: { origin: 'https://app.example.test' },
      }),
    )
    process.env.BETTER_AUTH_URL = 'http://remote.example.test'
    assert.throws(authOrigin, /HTTPS origin/)
  } finally {
    if (saved === undefined) delete process.env.BETTER_AUTH_URL
    else process.env.BETTER_AUTH_URL = saved
  }
  await assert.rejects(
    readJson(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[12345]',
      }),
      4,
    ),
    { status: 413 },
  )
  await assert.rejects(
    readJson(
      new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    ),
    { status: 400 },
  )
})

// Real library session validation and handlers against a disposable local database; no OAuth bypass in application code.
test(
  'signed sessions, ownership, preferences, logout and recoverable unique spaces',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
    const database = `identity_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${database}"`)
    url.pathname = `/${database}`
    process.env.DATABASE_URL = url.href
    process.env.DATABASE_DRIVER = 'postgres'
    process.env.BETTER_AUTH_URL = 'http://localhost:3000'
    process.env.BETTER_AUTH_SECRET = 'identity-tests-only-secret-32-characters-long'
    process.env.GOOGLE_CLIENT_ID = 'fixture.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'fixture-only'
    const db = getDb()
    try {
      await migrate(db, { migrationsFolder })
      const auth = getAuth()
      const context = await auth.$context
      process.env.BETTER_AUTH_URL = 'https://app.example.test'
      const secureAuth = createAuth(db)
      assert.equal((await secureAuth.$context).authCookies.sessionToken.attributes.secure, true)
      process.env.BETTER_AUTH_URL = 'http://localhost:3000'
      assert.deepEqual(
        context.socialProviders.map((provider) => provider.id),
        ['google'],
      )
      const cookie = context.authCookies.sessionToken
      assert.equal(cookie.attributes.httpOnly, true)
      assert.equal(cookie.attributes.sameSite, 'lax')
      const a = await context.internalAdapter.createUser(
        {
          ...googleProfile({
            name: 'A',
            given_name: 'Given',
            family_name: 'Family',
            email: 'a@example.test',
          }),
          emailVerified: true,
        },
        { method: 'oauth', oauth: { providerId: 'google' } },
      )
      const b = await context.internalAdapter.createUser(
        { name: 'B', email: 'b@example.test', emailVerified: true },
        { method: 'oauth', oauth: { providerId: 'google' } },
      )
      assert.equal((await db.select().from(spaces).where(eq(spaces.ownerId, a.id))).length, 1)
      const attempts = await Promise.all(Array.from({ length: 8 }, () => ensureSpace(a.id)))
      assert.ok(attempts.every((space) => space.id === attempts[0].id))
      await db.delete(spaces).where(eq(spaces.ownerId, a.id))
      const aSession = await context.internalAdapter.createSession(a.id, false)
      const bSession = await context.internalAdapter.createSession(b.id, false)
      assert.ok(aSession && bSession)
      assert.equal(
        (await db.select().from(spaces).where(eq(spaces.ownerId, a.id))).length,
        1,
        'session hook repairs a missing space',
      )
      const header = async (token: string) =>
        `${cookie.name}=${encodeURIComponent(`${token}.${await makeSignature(token, process.env.BETTER_AUTH_SECRET!)}`)}`
      const aCookie = await header(aSession.token)
      const bCookie = await header(bSession.token)
      const request = (
        path: string,
        cookieValue?: string,
        method = 'GET',
        body?: string,
        origin = 'http://localhost:3000',
      ) =>
        new Request(`http://localhost:3000${path}`, {
          method,
          headers: {
            ...(cookieValue ? { cookie: cookieValue } : {}),
            origin,
            'content-type': 'application/json',
          },
          ...(body ? { body } : {}),
        })
      const login = await authPOST(
        request(
          '/api/auth/sign-in/social',
          undefined,
          'POST',
          JSON.stringify({ provider: 'google', callbackURL: 'http://localhost:3000' }),
        ),
      )
      assert.equal(login.status, 200)
      const googleURL = new URL((await login.json()).url)
      assert.equal(googleURL.hostname, 'accounts.google.com')
      assert.deepEqual(
        new Set(googleURL.searchParams.get('scope')!.split(' ')),
        new Set(['openid', 'email', 'profile']),
      )
      assert.equal(
        googleURL.searchParams.get('redirect_uri'),
        'http://localhost:3000/api/auth/callback/google',
      )
      assert.equal(googleURL.searchParams.has('hd'), false)
      for (const endpoint of [me, preferences, models]) {
        assert.equal((await endpoint(request('/api/me'))).status, 401)
        assert.equal((await endpoint(request('/api/me', `${cookie.name}=forged`))).status, 401)
      }
      assert.equal(await requireOwner(request('/api/me', aCookie)), a.id)
      assert.equal((await authGET(request('/api/auth/get-session', aCookie))).status, 200)
      const profileResponse = await me(request('/api/me', aCookie))
      assert.equal(profileResponse.headers.get('cache-control'), 'private, no-store')
      const profile = await profileResponse.json()
      assert.equal(profile.id, a.id)
      assert.equal(profile.firstName, 'Given')
      assert.equal(profile.lastName, 'Family')
      assert.notEqual(
        profile.spaceId,
        (await me(request('/api/me', bCookie)).then((r) => r.json())).spaceId,
      )
      assert.equal(
        (
          await update(
            request(
              '/api/me/preferences',
              aCookie,
              'PATCH',
              JSON.stringify({ model: 'gpt-6.1-sol', effort: 'none' }),
            ),
          )
        ).status,
        400,
      )
      assert.equal(
        (
          await update(
            request(
              '/api/me/preferences',
              aCookie,
              'PATCH',
              JSON.stringify({ model: 'gpt-6-luna', effort: 'medium', ownerId: b.id }),
            ),
          )
        ).status,
        400,
      )
      assert.equal(
        (
          await update(
            request(
              '/api/me/preferences',
              aCookie,
              'PATCH',
              JSON.stringify({ model: 'gpt-6.1-sol', effort: 'high' }),
              'https://evil.example.test',
            ),
          )
        ).status,
        403,
      )
      assert.equal(
        (
          await update(
            request(
              '/api/me/preferences',
              aCookie,
              'PATCH',
              JSON.stringify({ model: 'gpt-6.1-sol', effort: 'high' }),
            ),
          )
        ).status,
        200,
      )
      assert.deepEqual(
        await preferences(request('/api/me/preferences', aCookie)).then((r) => r.json()),
        { model: 'gpt-6.1-sol', effort: 'high' },
      )
      assert.deepEqual(
        await preferences(request('/api/me/preferences', bCookie)).then((r) => r.json()),
        DEFAULT_PREFERENCES,
      )
      assert.equal((await db.select().from(user).where(eq(user.id, b.id)))[0].preferredModel, null)
      const catalog = await models(request('/api/models', aCookie)).then((r) => r.json())
      assert.equal(catalog.models.length, 2)
      assert.equal(
        (
          await authPOST(
            request('/api/auth/update-user', aCookie, 'POST', JSON.stringify({ name: 'Changed' })),
          )
        ).status,
        404,
      )
      const logout = await authPOST(request('/api/auth/sign-out', aCookie, 'POST', '{}'))
      assert.equal(logout.status, 200)
      assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/i)
      assert.equal((await me(request('/api/me', aCookie))).status, 401)
      assert.equal((await me(request('/api/me', bCookie))).status, 200)
      await db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.id, bSession.id))
      assert.equal((await me(request('/api/me', bCookie))).status, 401)
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
