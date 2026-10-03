import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test('dev schedules only persistent watching web and worker tasks without build prerequisites', () => {
  const result = spawnSync(
    process.execPath,
    ['node_modules/turbo/bin/turbo', 'run', 'dev', '--filter=./apps/*', '--dry=json'],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /circular package dependency/i)
  const graph = JSON.parse(result.stdout)
  assert.deepEqual(graph.tasks.map((task: { taskId: string }) => task.taskId).sort(), [
    'agent-web#dev',
    'agent-worker#dev',
  ])
  for (const task of graph.tasks) {
    assert.deepEqual(task.dependencies, [])
    assert.equal(task.resolvedTaskDefinition.persistent, true)
    assert.equal(task.resolvedTaskDefinition.cache, false)
  }
  assert.match(
    graph.tasks.find((task: { package: string }) => task.package === 'agent-worker').command,
    /--import @agent\/environment\/register .*--watch/,
  )
})
