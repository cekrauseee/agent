import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

test('shared Node preset compiles native imports and rejects unsafe nullable access', () => {
  const directory = mkdtempSync(join(process.cwd(), '.compiler-'))
  try {
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({ extends: '@agent/typescript-config/node', include: ['input.ts'] }),
    )
    const file = join(directory, 'input.ts')
    const compiler = resolve('node_modules/typescript/bin/tsc')
    const run = () =>
      spawnSync(process.execPath, [compiler, '--project', directory], { encoding: 'utf8' })
    writeFileSync(file, "import { readFileSync } from 'node:fs'\nreadFileSync('fixture')\n")
    assert.equal(run().status, 0)
    writeFileSync(
      file,
      "const value = Math.random() > 0.5 ? 'hello' : undefined\nvalue.toUpperCase()\n",
    )
    const rejected = run()
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stdout, /possibly 'undefined'/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
