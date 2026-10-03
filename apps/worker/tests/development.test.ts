import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))

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
    graph.tasks.find((task: { package: string }) => task.package === '@agent/worker').command,
    /--env-file-if-exists=\.env .*--watch/,
  )
})
