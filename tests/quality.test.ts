import assert from 'node:assert/strict'
import test from 'node:test'
import { ESLint } from 'eslint'
import { format, resolveConfig } from 'prettier'

test('quality tools reject unused/deprecated code and apply the formatter policy', async () => {
  const eslint = new ESLint()
  const source =
    '/** @deprecated Use a supported API. */\nfunction oldApi() {}\noldApi()\nconst unused = 1\n'
  for (const filePath of ['tests/quality.test.ts', 'scripts/setup.mjs']) {
    const [result] = await eslint.lintText(source, { filePath })
    for (const rule of ['@typescript-eslint/no-unused-vars', '@typescript-eslint/no-deprecated']) {
      assert.ok(
        result.messages.some((message) => message.ruleId === rule && message.severity === 2),
        `${filePath}: ${rule} must reject the fixture`,
      )
    }
  }
  const config = await resolveConfig('apps/web/app/page.tsx')
  assert.ok(config)
  assert.equal(
    await format('const value = "hello";\n', { ...config, parser: 'typescript' }),
    "const value = 'hello'\n",
  )
})
