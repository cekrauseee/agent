import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('web env loading preserves literal secrets and maps APP_PORT before Next starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-env-'))
  try {
    const envFile = join(directory, '.env')
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'node_modules/@agent'), { recursive: true })
    symlinkSync(
      fileURLToPath(new URL('../../../packages/environment', import.meta.url)),
      join(directory, 'node_modules/@agent/environment'),
      'dir',
    )
    const preload = join(directory, 'scripts/web-env.mjs')
    copyFileSync(join(root, 'scripts/web-env.mjs'), preload)
    writeFileSync(envFile, "APP_PORT=4317\nPORT=9999\nAGENT_ENV_FIXTURE='$LITERAL'\n")
    const env = { ...process.env }
    for (const key of ['APP_PORT', 'PORT', 'AGENT_ENV_FIXTURE']) delete env[key]
    const values = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          preload,
          '--eval',
          'console.log(JSON.stringify([process.env.PORT, process.env.AGENT_ENV_FIXTURE]))',
        ],
        { cwd: root, env, encoding: 'utf8' },
      ),
    )
    assert.deepEqual(values, ['4317', '$LITERAL'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
