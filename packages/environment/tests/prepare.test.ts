import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { prepareEnv } from '../src/index.mjs'

test('project preparation preserves secrets and refuses invalid configuration before replacing files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'project-env-'))
  try {
    writeFileSync(
      join(directory, '.env.example'),
      'APP_PORT=3000\nBETTER_AUTH_URL=\nBETTER_AUTH_SECRET=\nOPENAI_API_KEY=\n',
    )
    const file = join(directory, '.env')
    const secret = 'abcdefghijklmnopqrstuvwxyz0123456789'
    writeFileSync(file, `APP_PORT=4317\nBETTER_AUTH_SECRET=${secret}\nOPENAI_API_KEY='$LITERAL'\n`)
    prepareEnv(directory)
    const values = parseEnv(readFileSync(file, 'utf8'))
    assert.equal(values.BETTER_AUTH_URL, 'http://localhost:4317')
    assert.equal(values.BETTER_AUTH_SECRET, secret)
    assert.equal(values.OPENAI_API_KEY, '$LITERAL')
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const invalid = 'APP_PORT=4317\nBETTER_AUTH_SECRET=short\n'
    writeFileSync(file, invalid)
    assert.throws(() => prepareEnv(directory), /too short/)
    assert.equal(readFileSync(file, 'utf8'), invalid)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
