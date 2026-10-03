import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { mergeEnv } from '../src/index.mjs'

const template =
  '# Local fixture\nOPENAI_API_KEY=\nBETTER_AUTH_SECRET=\nBETTER_AUTH_URL=http://localhost:3000\nGOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nAPP_PORT=3000\n'

test('setup env upsert preserves raw values and follows the example', () => {
  const existing =
    '# Old comment\r\nOPENAI_API_KEY="a # value $OTHER"\r\nBETTER_AUTH_SECRET=first\r\nexport BETTER_AUTH_SECRET=abcdefghijklmnopqrstuvwxyz0123456789\r\nGOOGLE_CLIENT_SECRET="line one\nline two\\nline three"\nAPP_PORT=37419\nOBSOLETE_KEY=remove-me\n'
  const output = mergeEnv(template, existing, { BETTER_AUTH_URL: 'http://localhost:37419' })
  const values = parseEnv(output)
  const previous = parseEnv(existing)
  for (const key of ['OPENAI_API_KEY', 'BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'APP_PORT'])
    assert.equal(values[key], previous[key])
  assert.ok(output.includes('OPENAI_API_KEY="a # value $OTHER"'))
  assert.equal(values.BETTER_AUTH_URL, 'http://localhost:37419')
  assert.equal(values.GOOGLE_CLIENT_ID, '')
  assert.equal(values.OBSOLETE_KEY, undefined)
  assert.deepEqual(Object.keys(values), Object.keys(parseEnv(template)))
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('#')),
    template.split('\n').filter((line) => line.startsWith('#')),
  )
  assert.equal(mergeEnv(template, output), output, 'upsert must be idempotent')
  for (const input of ['', 'BETTER_AUTH_SECRET=""\n']) {
    const generated = parseEnv(mergeEnv(template, input))
    assert.ok(generated.BETTER_AUTH_SECRET)
    assert.match(generated.BETTER_AUTH_SECRET, /^[a-f0-9]{64}$/)
    assert.equal(generated.OPENAI_API_KEY, '', 'external credentials are never fabricated')
  }
})
