import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { mergeEnv, parseConfirmation, setup } from '../scripts/setup.mjs'

const template = readFileSync('.env.example', 'utf8')

test('setup confirmations accept yes/no with no as the default', () => {
  for (const answer of ['', ' ', 'n', 'N', 'no', 'NO'])
    assert.equal(parseConfirmation(answer), false)
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y '])
    assert.equal(parseConfirmation(answer), true)
  for (const answer of ['fresh start', 'maybe'])
    assert.throws(() => parseConfirmation(answer), /answer yes or no/)
})

test('setup env upsert preserves raw values and follows the example', () => {
  const existing =
    '# Old comment\r\nOPENAI_API_KEY="a # value $OTHER"\r\nBETTER_AUTH_SECRET=first\r\nexport BETTER_AUTH_SECRET=abcdefghijklmnopqrstuvwxyz0123456789\r\nGOOGLE_CLIENT_SECRET="line one\nline two\\nline three"\nAPP_PORT=37419\nOBSOLETE_KEY=remove-me\n'
  const output = mergeEnv(template, existing, { BETTER_AUTH_URL: 'http://localhost:37419' })
  const values = parseEnv(output)
  const previous = parseEnv(existing)
  for (const key of ['OPENAI_API_KEY', 'BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'APP_PORT'])
    assert.equal(values[key], previous[key])
  assert.ok(output.includes('OPENAI_API_KEY="a # value $OTHER"'))
  assert.equal(values.BETTER_AUTH_URL, 'http://localhost:37419')
  assert.equal(values.GOOGLE_CLIENT_ID, '')
  assert.equal(values.OBSOLETE_KEY, undefined)
  assert.deepEqual(Object.keys(values), Object.keys(parseEnv(template)))
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('#')),
    template.split('\n').filter((line) => line.startsWith('#')),
  )
  assert.equal(mergeEnv(template, output), output, 'upsert must be idempotent')
  for (const input of ['', 'BETTER_AUTH_SECRET=""\n']) {
    const generated = parseEnv(mergeEnv(template, input))
    assert.ok(generated.BETTER_AUTH_SECRET)
    assert.match(generated.BETTER_AUTH_SECRET, /^[a-f0-9]{64}$/)
    assert.equal(generated.OPENAI_API_KEY, '', 'external credentials are never fabricated')
  }
})

test('setup orchestrates reuse, fresh start and migration ordering safely', async () => {
  for (const scenario of ['new', 'reuse', 'fresh', 'volume', 'denied', 'failed-build'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
    writeFileSync(join(root, '.env.example'), template)
    const calls: {
      executable: string
      args: string[]
      environment: Record<string, string | undefined>
    }[] = []
    let prompts = 0
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
          : JSON.stringify({ Service: 'app', Publishers: [{ PublishedPort: 37419 }] }) +
              '\n' +
              JSON.stringify({ Service: 'postgres', Publishers: [{ PublishedPort: 57419 }] })
      if (args.includes('ls')) return scenario === 'volume' ? 'isolated-test-volume\n' : ''
      if (args.includes('build') && scenario === 'failed-build') throw new Error('build failed')
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
      if (scenario === 'failed-build') await assert.rejects(invoke(), /build failed/)
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
      assert.equal(values.APP_PORT, process.env.APP_PORT || '3000')
      assert.equal(values.POSTGRES_PORT, process.env.POSTGRES_PORT || '5432')
      assert.equal(
        values.DATABASE_URL,
        `postgresql://agent:agent-local@localhost:${values.POSTGRES_PORT}/agent`,
      )
      assert.equal(values.BETTER_AUTH_URL, `http://localhost:${values.APP_PORT}`)
      assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600)
      const migration = calls.findIndex((call) => call.args.includes('db:migrate'))
      if (scenario === 'failed-build') {
        assert.equal(migration, -1)
        continue
      }
      const stop = calls.findIndex((call) => call.args.includes('stop'))
      const postgresUp = calls.findIndex(
        (call) => call.args.includes('up') && call.args.at(-1) === 'postgres',
      )
      const consumersUp = calls.findIndex(
        (call) => call.args.includes('up') && call.args.at(-1) === 'worker',
      )
      assert.ok(stop < migration && postgresUp < migration && migration < consumersUp)
      assert.equal(calls[migration].environment.BETTER_AUTH_SECRET, undefined)
      assert.ok(
        calls[migration].args.includes(join(root, '.env')),
        'Compose must load .env directly, including interpolation',
      )
      assert.ok(calls.some((call) => call.args.includes('--frozen-lockfile')))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('setup confirms port conflicts and stops only approved containers after a successful build', async () => {
  for (const scenario of [
    'accept',
    'decline',
    'partial',
    'failed-build',
    'stop-failed',
    'non-interactive',
    'configured',
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'agent-setup-'))
    writeFileSync(join(root, '.env.example'), template)
    const existing =
      scenario === 'configured'
        ? 'APP_PORT=37419\nPOSTGRES_PORT=57419\nBETTER_AUTH_URL=http://localhost:37419\n'
        : 'APP_PORT=3000\nPOSTGRES_PORT=5432\n'
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
            id: 'app-conflict',
            name: '/other-app',
            project: 'other',
            ports: {
              '8080/tcp': [
                { HostIp: '0.0.0.0', HostPort: appPort },
                { HostIp: '::', HostPort: appPort },
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
              '3000/udp': [{ HostIp: '0.0.0.0', HostPort: appPort }],
            },
          },
        ]
          .map((container) => JSON.stringify(container))
          .join('\n')
      if (args.includes('build') && scenario === 'failed-build') throw new Error('build failed')
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
      else if (scenario === 'failed-build' || scenario === 'stop-failed')
        await assert.rejects(setup(root, run, confirm), /failed/)
      else await setup(root, run, confirm)

      if (scenario !== 'non-interactive') {
        assert.equal(questions.length, scenario === 'decline' ? 1 : 2)
        assert.match(questions[0], new RegExp(`other-app.*port\\(s\\) ${appPort}\\.`))
        if (questions[1]) assert.ok(questions[1].includes(`port(s) ${postgresPort}.`))
      }
      const stop = calls.findIndex((args) => args[0] === 'stop')
      if (['accept', 'configured', 'stop-failed'].includes(scenario)) {
        assert.deepEqual(calls[stop], ['stop', 'app-conflict', 'db-conflict'])
        assert.ok(calls.findIndex((args) => args.includes('build')) < stop)
      } else assert.equal(stop, -1, 'no container is stopped unless all prompts and build succeed')
      if (['decline', 'partial', 'non-interactive'].includes(scenario)) {
        assert.equal(readFileSync(join(root, '.env'), 'utf8'), existing)
        assert.equal(
          calls.some((args) => args.includes('build')),
          false,
        )
      }
      if (scenario === 'accept' || scenario === 'configured') {
        assert.ok(stop < calls.findIndex((args) => args.includes('up')))
        const values = parseEnv(readFileSync(join(root, '.env'), 'utf8'))
        assert.equal(values.APP_PORT, appPort)
        assert.equal(values.POSTGRES_PORT, postgresPort)
        assert.equal(values.BETTER_AUTH_URL, `http://localhost:${appPort}`)
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
  writeFileSync(join(root, '.env'), 'BETTER_AUTH_SECRET=too-short\n')
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
      /too short/,
    )
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'BETTER_AUTH_SECRET=too-short\n')
    assert.equal(mutations, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
