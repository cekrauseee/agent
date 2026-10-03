import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { parseConfirmation, setup } from '../scripts/setup.mjs'

const template = readFileSync('.env.example', 'utf8')

test('setup confirmations accept yes/no with no as the default', () => {
  for (const answer of ['', ' ', 'n', 'N', 'no', 'NO'])
    assert.equal(parseConfirmation(answer), false)
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y '])
    assert.equal(parseConfirmation(answer), true)
  for (const answer of ['fresh start', 'maybe'])
    assert.throws(() => parseConfirmation(answer), /answer yes or no/)
})

test('setup orchestrates reuse, fresh start and migration ordering safely', async () => {
  for (const scenario of [
    'new',
    'reuse',
    'fresh',
    'volume',
    'denied',
    'failed-install',
    'failed-ready',
    'failed-migration',
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
    writeFileSync(join(root, '.env.example'), template)
    const calls: {
      executable: string
      args: string[]
      environment: Record<string, string | undefined>
    }[] = []
    let prompts = 0
    const inheritedDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://ignored:ignored@localhost:9/ignored'
    const run = (
      _root: string,
      environment: Record<string, string | undefined>,
      executable: string,
      args: string[],
    ) => {
      calls.push({ executable, args, environment: { ...environment } })
      if (args.includes('config')) return '{"name":"isolated-setup-test"}'
      if (args[0] === 'ps') return ''
      if (args.includes('ps'))
        return scenario === 'new' || scenario === 'volume'
          ? '[]'
          : JSON.stringify({
              Service: 'app',
              State: scenario === 'fresh' ? 'running' : 'exited',
              Publishers: [{ PublishedPort: 37419 }],
            }) +
              '\n' +
              JSON.stringify({ Service: 'postgres', Publishers: [{ PublishedPort: 57419 }] })
      if (args.includes('ls')) return scenario === 'volume' ? 'isolated-test-volume\n' : ''
      if (args.includes('install') && scenario === 'failed-install')
        throw new Error('install failed')
      if (args.includes('up') && scenario === 'failed-ready') throw new Error('readiness failed')
      if (args.includes('db:migrate') && scenario === 'failed-migration')
        throw new Error('migration failed')
      return ''
    }
    try {
      if (scenario === 'denied') {
        await assert.rejects(
          setup(root, run, async () => {
            prompts++
            throw new Error('authorization denied')
          }),
          /authorization denied/,
        )
        assert.equal(prompts, 1)
        assert.equal(
          calls.some((call) => call.args.includes('down')),
          false,
        )
        assert.equal(
          calls.some((call) => call.executable === 'pnpm' && call.args.includes('install')),
          false,
        )
        assert.throws(() => readFileSync(join(root, '.env')))
        continue
      }
      const invoke = () =>
        setup(root, run, async (question) => {
          prompts++
          assert.ok(question.includes('ALL local PostgreSQL data. Fresh start?'))
          return parseConfirmation(scenario === 'fresh' ? 'Y' : '')
        })
      if (scenario.startsWith('failed-')) await assert.rejects(invoke(), /failed/)
      else await invoke()
      assert.equal(prompts, scenario === 'new' ? 0 : 1)
      const down = calls.findIndex((call) => call.args.includes('down'))
      assert.equal(
        down !== -1,
        scenario === 'fresh',
        'data deletion requires affirmative permission',
      )
      if (down !== -1) assert.ok(calls[down].args.includes('--volumes'))
      const values = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
      assert.equal(values.POSTGRES_PORT, process.env.POSTGRES_PORT || '5432')
      assert.equal(
        values.DATABASE_URL,
        `postgresql://agent:agent-local@localhost:${values.POSTGRES_PORT}/agent`,
      )
      assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600)
      const migration = calls.findIndex((call) => call.args.includes('db:migrate'))
      const install = calls.findIndex((call) => call.args.includes('install'))
      const postgresUp = calls.findIndex(
        (call) => call.args.includes('up') && call.args.at(-1) === 'postgres',
      )
      assert.equal(
        calls.some((call) => call.args.includes('build') || call.args.includes('run')),
        false,
      )
      assert.equal(
        calls.some((call) => call.args.includes('app') || call.args.includes('worker')),
        false,
      )
      if (scenario === 'failed-install') {
        assert.equal(postgresUp, -1)
        assert.equal(migration, -1)
      } else if (scenario === 'failed-ready') {
        assert.ok(install < postgresUp)
        assert.equal(migration, -1)
      } else {
        assert.ok(install < postgresUp && postgresUp < migration)
        if (down !== -1) assert.ok(install < down && down < postgresUp)
        assert.ok(calls[postgresUp].args.includes('--wait'))
        assert.ok(calls[postgresUp].args.includes(join(root, '.env')))
        assert.equal(calls[migration].executable, 'pnpm')
        assert.deepEqual(calls[migration].args, ['db:migrate'])
        for (const key of Object.keys(parseEnv(template)))
          assert.equal(
            calls[migration].environment[key],
            undefined,
            'host commands must load backend .env',
          )
        assert.equal(migration, calls.length - 1, 'setup never launches persistent host apps')
      }
      assert.ok(calls.some((call) => call.args.includes('--frozen-lockfile')))
    } finally {
      if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = inheritedDatabaseUrl
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('setup confirms port conflicts and stops only approved containers after a successful install', async () => {
  for (const scenario of [
    'accept',
    'decline',
    'partial',
    'failed-install',
    'stop-failed',
    'non-interactive',
    'configured',
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
    writeFileSync(join(root, '.env.example'), template)
    const existing = scenario === 'configured' ? 'POSTGRES_PORT=57419\n' : 'POSTGRES_PORT=5432\n'
    writeFileSync(join(root, '.env'), existing)
    const appPort = scenario === 'configured' ? '37419' : '3000'
    const postgresPort = scenario === 'configured' ? '57419' : '5432'
    const calls: string[][] = []
    const questions: string[] = []
    const run = (_root: string, _environment: unknown, _executable: string, args: string[]) => {
      calls.push(args)
      if (args.includes('config')) return '{"name":"agent"}'
      if (args[0] === 'ps') return 'own\napp-conflict\ndb-conflict\nunrelated\n'
      if (args.includes('ps')) return '[]'
      if (args[0] === 'inspect')
        return [
          {
            id: 'own',
            name: '/agent-app-1',
            project: 'agent',
            ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: appPort }] },
          },
          {
            id: 'first-db-conflict',
            name: '/first-db',
            project: 'other',
            ports: {
              '8080/tcp': [
                { HostIp: '0.0.0.0', HostPort: postgresPort },
                { HostIp: '::', HostPort: postgresPort },
              ],
            },
          },
          {
            id: 'db-conflict',
            name: '/other-db',
            project: '',
            ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: postgresPort }] },
          },
          {
            id: 'unrelated',
            name: '/unrelated',
            project: 'other',
            ports: {
              '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '4000' }],
              '5432/tcp': null,
              '8000/tcp': [{ HostIp: '192.0.2.1', HostPort: appPort }],
              '3000/udp': [{ HostIp: '0.0.0.0', HostPort: postgresPort }],
            },
          },
        ]
          .map((container) => JSON.stringify(container))
          .join('\n')
      if (args.includes('install') && scenario === 'failed-install')
        throw new Error('install failed')
      if (args[0] === 'stop' && scenario === 'stop-failed') throw new Error('stop failed')
      return ''
    }
    const confirm = async (question: string) => {
      questions.push(question)
      return parseConfirmation(
        scenario === 'decline' || (scenario === 'partial' && questions.length === 2) ? '' : 'Y',
      )
    }
    try {
      if (scenario === 'non-interactive') {
        if (process.stdin.isTTY) continue
        await assert.rejects(setup(root, run), /terminal/)
      } else if (scenario === 'decline' || scenario === 'partial')
        await assert.rejects(setup(root, run, confirm), /configured ports remain occupied/)
      else if (scenario === 'failed-install' || scenario === 'stop-failed')
        await assert.rejects(setup(root, run, confirm), /failed/)
      else await setup(root, run, confirm)

      if (scenario !== 'non-interactive') {
        assert.equal(questions.length, scenario === 'decline' ? 1 : 2)
        assert.match(questions[0], new RegExp(`first-db.*port\\(s\\) ${postgresPort}\\.`))
        if (questions[1]) assert.ok(questions[1].includes(`port(s) ${postgresPort}.`))
      }
      const stop = calls.findIndex((args) => args[0] === 'stop')
      if (['accept', 'configured', 'stop-failed'].includes(scenario)) {
        assert.deepEqual(calls[stop], ['stop', 'first-db-conflict', 'db-conflict'])
        assert.ok(calls.findIndex((args) => args.includes('install')) < stop)
      } else
        assert.equal(stop, -1, 'no container is stopped unless all prompts and install succeed')
      if (['decline', 'partial', 'non-interactive'].includes(scenario)) {
        assert.equal(readFileSync(join(root, '.env'), 'utf8'), existing)
        assert.equal(
          calls.some((args) => args.includes('install')),
          false,
        )
      }
      if (scenario === 'accept' || scenario === 'configured') {
        assert.ok(stop < calls.findIndex((args) => args.includes('up')))
        const values = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
        assert.equal(values.POSTGRES_PORT, postgresPort)
      } else
        assert.equal(
          calls.some((args) => args.includes('up')),
          false,
        )
      assert.equal(
        calls.some((args) => args.includes('down') || args[0] === 'rm'),
        false,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('setup fails closed without a terminal for existing data and preserves invalid configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
  writeFileSync(join(root, '.env.example'), template)
  writeFileSync(join(root, '.env'), 'POSTGRES_PORT=invalid\n')
  let mutations = 0
  const run = (_root: string, _environment: unknown, _executable: string, args: string[]) => {
    if (args.includes('config')) return '{"name":"isolated-setup-test"}'
    if (args.includes('ps')) return '[{"Service":"postgres"}]'
    if (
      args.includes('down') ||
      args.includes('stop') ||
      args.includes('build') ||
      args.includes('up')
    )
      mutations++
    return ''
  }
  try {
    if (!process.stdin.isTTY) await assert.rejects(setup(root, run), /terminal/)
    await assert.rejects(
      setup(root, run, async () => false),
      /valid port/,
    )
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'POSTGRES_PORT=invalid\n')
    assert.equal(mutations, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('setup requires manual legacy consumer shutdown on reuse and retains stopped containers', async () => {
  for (const state of ['running', 'restarting', 'paused', 'exited', 'created']) {
    for (const service of ['app', 'worker']) {
      const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
      writeFileSync(join(root, '.env.example'), template)
      const existing = 'POSTGRES_PORT=5432\n'
      writeFileSync(join(root, '.env'), existing)
      const calls: string[][] = []
      const run = (_root: string, _environment: unknown, _executable: string, args: string[]) => {
        calls.push(args)
        if (args.includes('config')) return '{"name":"agent"}'
        if (args.includes('ps') && args.includes('--all')) {
          assert.ok(args.includes('--orphans'), 'removed app/worker services must remain visible')
          return JSON.stringify([{ Service: service, State: state }])
        }
        return ''
      }
      try {
        if (['running', 'restarting', 'paused'].includes(state)) {
          await assert.rejects(
            setup(root, run, async () => false),
            /Stop them manually with docker stop/,
          )
          assert.equal(readFileSync(join(root, '.env'), 'utf8'), existing)
          assert.equal(
            calls.some((args) => args.includes('install') || args.includes('up')),
            false,
          )
        } else await setup(root, run, async () => false)
        assert.equal(
          calls.some((args) => args.includes('down') || args.includes('stop')),
          false,
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
})
