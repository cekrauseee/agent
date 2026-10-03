import assert from 'node:assert/strict'
import test from 'node:test'
import { format, resolveConfig } from 'prettier'

test('exported formatter policy resolves and formats TypeScript consistently', async () => {
  const config = await resolveConfig('tests/format.test.ts')
  assert.ok(config)
  assert.equal(
    await format('const value = "hello";\n', { ...config, parser: 'typescript' }),
    "const value = 'hello'\n",
  )
})
