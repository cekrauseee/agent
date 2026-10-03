import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { migrationsFolder } from '@agent/backend/db/migrations'

test('worker loads without Next or secrets and migrations resolve from either package directory', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const env = { ...process.env }
  for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'BETTER_AUTH_SECRET']) delete env[key]
  for (const cwd of ['apps/worker', 'packages/backend']) {
    execFileSync(
      process.execPath,
      [
        '--conditions=react-server',
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import assert from 'node:assert/strict';
         import { migrationsFolder } from '@agent/backend/db/migrations';
         assert.equal(migrationsFolder, process.argv[1]);
         assert.throws(() => import.meta.resolve('next'));
         ${cwd === 'apps/worker' ? "const { reconcile } = await import('./src/worker.ts'); assert.equal(typeof reconcile, 'function');" : ''}`,
        migrationsFolder,
      ],
      { cwd: join(root, cwd), env },
    )
  }
  assert.equal(migrationsFolder, join(root, 'packages/backend/drizzle'))
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
  assert.ok(journal.entries.length > 0)
})
