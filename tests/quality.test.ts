import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ESLint } from 'eslint'
import { format, resolveConfig } from 'prettier'

const root = fileURLToPath(new URL('../', import.meta.url))

test('shared quality tools reject unused/deprecated code and apply the formatter policy', async () => {
  const source =
    '/** @deprecated Use a supported API. */\nfunction oldApi() {}\noldApi()\nconst unused = 1\n'
  for (const [directory, filePath] of [
    ['', 'tests/quality.test.ts'],
    ['', 'scripts/setup.mjs'],
    ['', 'packages/eslint-config/base.mjs'],
    ['apps/web', 'app/page.tsx'],
    ['apps/web', 'postcss.config.mjs'],
    ['apps/worker', 'src/worker.ts'],
    ['packages/backend', 'src/models.ts'],
    ['packages/backend', 'drizzle.config.ts'],
  ]) {
    const eslint = new ESLint({ cwd: join(root, directory) })
    const [result] = await eslint.lintText(source, { filePath })
    for (const rule of ['@typescript-eslint/no-unused-vars', '@typescript-eslint/no-deprecated']) {
      assert.ok(
        result.messages.some((message) => message.ruleId === rule && message.severity === 2),
        `${directory}/${filePath}: ${rule} must reject the fixture`,
      )
    }
    const config = await resolveConfig(join(root, directory, filePath))
    assert.ok(config)
    assert.equal(
      await format('const value = "hello";\n', { ...config, parser: 'typescript' }),
      "const value = 'hello'\n",
    )
  }
})

test('dev schedules only persistent watching web and worker tasks without build prerequisites', () => {
  const graph = JSON.parse(
    execFileSync(
      process.execPath,
      ['node_modules/turbo/bin/turbo', 'run', 'dev', '--filter=./apps/*', '--dry=json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ),
  )
  assert.deepEqual(graph.tasks.map((task: { taskId: string }) => task.taskId).sort(), [
    '@agent/web#dev',
    '@agent/worker#dev',
  ])
  for (const task of graph.tasks) {
    assert.deepEqual(task.dependencies, [])
    assert.equal(task.resolvedTaskDefinition.persistent, true)
    assert.equal(task.resolvedTaskDefinition.cache, false)
  }
  assert.match(
    graph.tasks.find((task: { package: string }) => task.package === '@agent/web').command,
    /--import \.\.\/\.\.\/scripts\/web-env\.mjs .*next dev$/,
  )
  assert.match(
    graph.tasks.find((task: { package: string }) => task.package === '@agent/worker').command,
    /--env-file-if-exists=\.\.\/\.\.\/\.env .*--watch/,
  )
})

test('native env loading preserves literal secrets and maps APP_PORT before Next starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-env-'))
  try {
    const envFile = join(directory, '.env')
    mkdirSync(join(directory, 'scripts'))
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
