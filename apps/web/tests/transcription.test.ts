import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { OpenAI } from '@agent/backend/server/openai'
import { Pool } from 'pg'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { makeSignature } from 'better-auth/crypto'
import { getAuth } from '@agent/backend/auth'
import { getDb } from '@agent/backend/db'
import { messages, paidRequests } from '@agent/backend/db/schema'
import { getOpenAI } from '@agent/backend/server/openai'
import { AUDIO_BODY_LIMIT, readAudio, transcribe } from '@agent/backend/transcription'
import { POST } from '../app/api/transcriptions/route'

const wav = Buffer.alloc(46)
wav.write('RIFF')
wav.writeUInt32LE(38, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(16000, 24)
wav.writeUInt32LE(32000, 28)
wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(2, 40)
function upload(file = new File([wav], 'speech.wav', { type: 'audio/wav' }), extra = false) {
  const form = new FormData()
  form.append('file', file)
  if (extra) form.append('model', 'other')
  return form
}
const req = (body: BodyInit, headers: HeadersInit = {}) =>
  new Request('http://localhost:3000/api/transcriptions', { method: 'POST', body, headers })

test('bounded multipart/audio validation, upload timeout and sanitized provider errors', async (t) => {
  assert.equal((await readAudio(req(upload()))).size, wav.length)
  for (const [extension, header, type] of [
    ['mp3', 'ID3', 'audio/mpeg'],
    ['mpga', 'ID3', 'audio/mpeg'],
    ['mpeg', 'ID3', 'audio/mpeg'],
    ['mp4', '0000ftyp', 'video/mp4'],
    ['m4a', '0000ftyp', 'audio/mp4'],
    ['webm', '\x1a\x45\xdf\xa3', 'audio/webm'],
  ]) {
    const bytes = Buffer.alloc(16)
    bytes.write(header, 0, 'latin1')
    assert.equal(
      (await readAudio(req(upload(new File([bytes], `speech.${extension}`, { type }))))).size,
      16,
    )
  }
  for (const [file, status] of [
    [new File([], 'empty.wav'), 400],
    [new File([wav], 'speech.txt'), 415],
    [new File([wav], 'speech.wav', { type: 'text/plain' }), 415],
    [new File(['this is not audio'], 'speech.wav'), 400],
  ] as const) {
    await assert.rejects(readAudio(req(upload(file))), { status })
  }
  await assert.rejects(readAudio(req(upload(undefined, true))), { status: 400 })
  await assert.rejects(
    readAudio(req('broken', { 'content-type': 'multipart/form-data; boundary=wrong' })),
    { status: 400 },
  )
  await assert.rejects(readAudio(req('{}', { 'content-type': 'application/json' })), {
    status: 415,
  })
  await assert.rejects(
    readAudio(req(upload(), { 'content-length': String(AUDIO_BODY_LIMIT + 1) })),
    { status: 413 },
  )
  let cancelled = false
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(AUDIO_BODY_LIMIT))
      c.enqueue(new Uint8Array(1))
    },
    cancel() {
      cancelled = true
    },
  })
  await assert.rejects(
    readAudio(
      new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    ),
    { status: 413 },
  )
  assert.equal(cancelled, true)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = readAudio(
    new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: new ReadableStream(),
      duplex: 'half',
    } as RequestInit),
  )
  const timeoutCheck = assert.rejects(pending, { status: 408 })
  t.mock.timers.tick(30_000)
  await timeoutCheck
  t.mock.timers.reset()
  const client = new OpenAI({
    apiKey: 'fixture-only',
    fetch: async () => Response.json({ text: 'Olá, 世界!\n' }),
  })
  assert.deepEqual(await transcribe(new File([wav], 'speech.wav'), client), {
    text: 'Olá, 世界!\n',
  })
  const method = t.mock.method(client.audio.transcriptions, 'create', async () => {
    throw new OpenAI.APIConnectionTimeoutError()
  })
  await assert.rejects(transcribe(new File([wav], 'speech.wav'), client), { status: 504 })
  method.mock.restore()
})

test(
  'authenticated route, exact SDK multipart contract, failure release and shared concurrency',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    const originalFetch = globalThis.fetch
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
    const name = `transcription_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${name}"`)
    url.pathname = `/${name}`
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      DATABASE_DRIVER: 'postgres',
      BETTER_AUTH_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'transcription-tests-only-secret-32-characters',
      GOOGLE_CLIENT_ID: 'fixture',
      GOOGLE_CLIENT_SECRET: 'fixture',
    })
    const db = getDb()
    let calls = 0
    let failure = 0
    let malformed = false
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://api.openai.com/v1/audio/transcriptions')
      assert.equal(init?.method, 'POST')
      const body = init?.body
      assert.ok(body instanceof FormData)
      assert.equal(body.get('model'), 'gpt-transcribe')
      assert.equal(body.get('prompt'), 'Transcribe the speech in its original language.')
      assert.equal(body.get('response_format'), 'json')
      assert.equal(body.has('language'), false)
      assert.equal(body.has('languages'), false)
      const file = body.get('file')
      assert.ok(file instanceof File)
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav)
      calls++
      return failure
        ? Response.json(
            { error: { message: 'sensitive provider details/audio/transcript' } },
            { status: failure },
          )
        : Response.json(malformed ? {} : { text: '  Olá, 日本語!\n', usage: { ignored: true } })
    }
    try {
      await migrate(db, { migrationsFolder })
      const context = await getAuth().$context
      const owner = await context.internalAdapter.createUser(
        { name: 'Audio', email: 'audio@example.test', emailVerified: true },
        { method: 'oauth', oauth: { providerId: 'google' } },
      )
      const session = await context.internalAdapter.createSession(owner.id, false)
      assert.ok(session)
      const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, process.env.BETTER_AUTH_SECRET!)}`)}`
      const headers = { origin: 'http://localhost:3000', cookie }
      for (const cookieValue of ['', 'forged'])
        assert.equal(
          (await POST(req(upload(), { origin: headers.origin, cookie: cookieValue }))).status,
          401,
        )
      assert.equal(
        (await POST(req(upload(), { ...headers, origin: 'https://foreign.test' }))).status,
        403,
      )
      assert.equal((await POST(req(upload(new File([], 'empty.wav')), headers))).status, 400)
      assert.equal(calls, 0)
      assert.equal((await db.select().from(paidRequests)).length, 0)
      delete process.env.OPENAI_API_KEY
      assert.equal((await POST(req(upload(), headers))).status, 503)
      assert.equal((await db.select().from(paidRequests)).length, 0)
      process.env.OPENAI_API_KEY = 'fixture-only'
      assert.equal(getOpenAI().timeout, 60_000)
      assert.equal(getOpenAI().maxRetries, 0)
      const response = await POST(req(upload(), headers))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.deepEqual(await response.json(), { text: '  Olá, 日本語!\n' })
      for (const [upstream, status] of [
        [400, 400],
        [422, 400],
        [401, 503],
        [429, 503],
        [500, 502],
      ]) {
        failure = upstream
        const before: number = calls
        const response = await POST(req(upload(), headers))
        assert.equal(response.status, status)
        assert.equal(calls, before + 1, 'no automatic paid retry')
        assert.doesNotMatch(JSON.stringify(await response.json()), /sensitive/)
        assert.equal(
          (
            await db
              .select()
              .from(paidRequests)
              .where(sql`${paidRequests.activeUntil} > now()`)
          ).length,
          0,
        )
      }
      failure = 0
      malformed = true
      assert.equal((await POST(req(upload(), headers))).status, 502)
      assert.equal(
        (await db.select().from(messages)).length,
        0,
        'transcription creates no conversation messages',
      )
      await db.delete(paidRequests)
      await db.insert(paidRequests).values(
        Array.from({ length: 3 }, () => ({
          id: randomUUID(),
          ownerId: owner.id,
          kind: 'chat',
          activeUntil: new Date(Date.now() + 60_000),
        })),
      )
      const before = calls
      assert.equal((await POST(req(upload(), headers))).status, 429)
      assert.equal(calls, before)
      await db.delete(paidRequests).where(eq(paidRequests.ownerId, owner.id))
    } finally {
      globalThis.fetch = originalFetch
      const globalDb = globalThis as typeof globalThis & {
        agentDatabase?: { close: () => Promise<void> }
      }
      await globalDb.agentDatabase?.close()
      delete globalDb.agentDatabase
      process.env = saved
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      await admin.end()
    }
  },
)
