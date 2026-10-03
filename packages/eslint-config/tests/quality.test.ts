import assert from 'node:assert/strict'
import test from 'node:test'
import { ESLint } from 'eslint'
import { nodeConfig } from '../node.mjs'
import { nextConfig } from '../next.mjs'

test('Node and Next presets reject unused and deprecated references', async () => {
  const source =
    '/** @deprecated Use a supported API. */\nfunction oldApi() {}\noldApi()\nconst unused = 1\n'
  for (const preset of [nodeConfig, nextConfig]) {
    const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: preset(process.cwd()) })
    const [result] = await eslint.lintText(source, { filePath: 'tests/quality.test.ts' })
    for (const rule of ['@typescript-eslint/no-unused-vars', '@typescript-eslint/no-deprecated'])
      assert.ok(
        result.messages.some((message) => message.ruleId === rule && message.severity === 2),
        rule,
      )
  }
})
