import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('browser fixture isolates API, preserves replacement identity, and streams canonical output', async () => {
  const values = new Map<string, string>()
  const browser = {
    fetch: () => {
      throw new Error('Unexpected real network request')
    },
  }
  const context = vm.createContext({
    window: browser,
    navigator: { mediaDevices: {} },
    location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/' },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    Response,
    Request,
    URL,
    TextEncoder,
    ReadableStream,
    crypto,
    DOMException,
  })
  vm.runInContext(
    await readFile(new URL('./browser-fixture.mjs', import.meta.url), 'utf8'),
    context,
  )
  const fetch = browser.fetch as unknown as typeof globalThis.fetch
  const conversation = await (
    await fetch('/api/conversations', { method: 'POST', body: '{}' })
  ).json()
  const path = `/api/conversations/${conversation.id}`
  const body = JSON.stringify({ requestId: crypto.randomUUID(), text: 'First question' })
  const admission = await (await fetch(`${path}/messages`, { method: 'POST', body })).json()
  const duplicate = await (await fetch(`${path}/messages`, { method: 'POST', body })).json()
  assert.equal(duplicate.userMessageId, admission.userMessageId)
  assert.equal(duplicate.deduplicated, true)
  const fixture = (
    browser as unknown as {
      __conversationFixture: {
        delta(id: string, text: string): void
        complete(id: string, text: string): void
      }
    }
  ).__conversationFixture
  const generationId = admission.generation.generationId
  const stream = await fetch(`${path}/generations/${generationId}/events?after=0`)
  fixture.delta(generationId, 'Partial')
  fixture.complete(generationId, 'Canonical answer')
  const events = await stream.text()
  assert.match(events, /event: status/)
  assert.match(events, /event: text_delta/)
  assert.match(events, /event: completed/)
  assert.match(events, /Canonical answer/)
  const replacement = await (
    await fetch(`${path}/messages/${admission.userMessageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ requestId: crypto.randomUUID(), text: 'Edited question' }),
    })
  ).json()
  assert.equal(replacement.userMessageId, admission.userMessageId)
  assert.notEqual(replacement.generation.generationId, generationId)
  const cancelled = await (
    await fetch(`${path}/generations/${replacement.generation.generationId}/cancel`, {
      method: 'POST',
    })
  ).json()
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await fetch('/api/unconfigured')).status, 404)
  await fetch('/api/auth/sign-out', { method: 'POST' })
  assert.equal((await fetch('/api/me')).status, 401)
})
