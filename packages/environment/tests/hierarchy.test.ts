import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadEnv, mergeEnv, readEnv } from '../src/index.mjs'

test('process, project and workspace settings keep their declared precedence', () => {
  const saved = { ...process.env }
  const root = mkdtempSync(join(tmpdir(), 'env-hierarchy-'))
  const project = join(root, 'apps/example')
  try {
    mkdirSync(project, { recursive: true })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(
      join(root, '.env'),
      "HIERARCHY_BASE=shared\nHIERARCHY_OVERRIDE=base\nHIERARCHY_PROCESS=base\nHIERARCHY_LITERAL='$LITERAL'\n",
    )
    writeFileSync(join(project, '.env'), 'HIERARCHY_OVERRIDE=project\nHIERARCHY_PROCESS=project\n')
    writeFileSync(join(project, '.env.local'), 'HIERARCHY_OVERRIDE=local\n')
    for (const key of ['HIERARCHY_BASE', 'HIERARCHY_OVERRIDE', 'HIERARCHY_LITERAL'])
      delete process.env[key]
    process.env.HIERARCHY_PROCESS = 'inherited'
    assert.equal(readEnv(project).HIERARCHY_OVERRIDE, 'local')
    assert.equal(
      process.env.HIERARCHY_OVERRIDE,
      undefined,
      'reading config does not mutate the process',
    )
    loadEnv(project)
    assert.equal(process.env.HIERARCHY_BASE, 'shared')
    assert.equal(process.env.HIERARCHY_OVERRIDE, 'local')
    assert.equal(process.env.HIERARCHY_PROCESS, 'inherited')
    assert.equal(process.env.HIERARCHY_LITERAL, '$LITERAL')
    delete process.env.HIERARCHY_OVERRIDE
    loadEnv(project, 'test')
    assert.equal(process.env.HIERARCHY_OVERRIDE, 'project', 'tests ignore local files')
  } finally {
    process.env = saved
    rmSync(root, { recursive: true, force: true })
  }
})

test('optional overrides stay unset until explicitly configured, including empty values', () => {
  const template = '# DATABASE_URL=example\n# OPENAI_API_KEY=\n'
  assert.equal(mergeEnv(template, ''), template)
  assert.equal(
    mergeEnv(template, "DATABASE_URL='$LITERAL'\nOPENAI_API_KEY=\n"),
    "DATABASE_URL='$LITERAL'\nOPENAI_API_KEY=\n",
  )
})
