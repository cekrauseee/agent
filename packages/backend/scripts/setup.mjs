import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mergeEnv, readEnv, writeEnv } from '@agent/environment'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

function command(root, environment, executable, args, capture = false) {
  try {
    return (
      execFileSync(executable, args, {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      }) ?? ''
    )
  } catch {
    throw new Error(
      `${executable} failed. Check that it is installed/running and the preceding command output; resolve the failure before rerunning setup.`,
    )
  }
}

export function parseConfirmation(answer) {
  const value = answer.trim().toLowerCase()
  if (!['', 'y', 'yes', 'n', 'no'].includes(value))
    throw new Error('Setup cancelled: answer yes or no (y/N).')
  return value === 'y' || value === 'yes'
}

async function confirmAction(question) {
  if (!process.stdin.isTTY)
    throw new Error('Run pnpm setup in a terminal to answer the confirmation prompts.')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return parseConfirmation(await prompt.question(`${question} [y/N]: `))
  } finally {
    prompt.close()
  }
}

/** The injected command/prompt let focused checks exercise setup without deleting real data. */
export async function setup(root, run = command, confirm = confirmAction) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24 || major >= 27)
    throw new Error('Install Node.js 24 LTS (supported: 24–26) before setup.')
  const file = join(root, '.env')
  const template = readFileSync(join(root, '.env.example'), 'utf8')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const postgresPort = readEnv(root).POSTGRES_PORT || '5432'
  const environment = { ...process.env, POSTGRES_PORT: postgresPort, COMPOSE_DISABLE_ENV_FILE: '1' }
  const compose = [
    'compose',
    '--project-name',
    'agent',
    '--project-directory',
    root,
    '--file',
    join(root, 'compose.yaml'),
  ]
  const docker = (args, capture = false) => run(root, environment, 'docker', args, capture)
  run(root, environment, 'pnpm', ['--version'], true)
  docker(['info', '--format', '{{.ServerVersion}}'], true)
  docker(['compose', 'version', '--short'], true)
  const config = JSON.parse(docker([...compose, 'config', '--format', 'json'], true))
  const output = docker([...compose, 'ps', '--all', '--orphans', '--format', 'json'], true).trim()
  const containers = output
    ? output.startsWith('[')
      ? JSON.parse(output)
      : output.split('\n').map((line) => JSON.parse(line))
    : []
  const volumes = docker(
    ['volume', 'ls', '--filter', `label=com.docker.compose.project=${config.name}`, '--quiet'],
    true,
  ).trim()
  const reset =
    containers.length || volumes
      ? await confirm(
          "Existing local containers or data found. Fresh start deletes this project's containers and ALL local PostgreSQL data. Fresh start?",
        )
      : false
  if (
    !reset &&
    containers.some(
      (container) =>
        ['app', 'worker'].includes(container.Service) &&
        ['running', 'restarting', 'paused'].includes(container.State),
    )
  )
    throw new Error(
      'Legacy app/worker containers are still active. Stop them manually with docker stop (find their names with docker compose ps --all --orphans), then rerun pnpm setup and choose reuse. Their data will be retained.',
    )

  for (const port of [postgresPort]) {
    if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('POSTGRES_PORT must be a valid port number.')
  }
  const updated = mergeEnv(template, existing, {
    POSTGRES_PORT: postgresPort,
    DATABASE_URL: `postgresql://agent:agent-local@localhost:${postgresPort}/agent`,
  })
  environment.POSTGRES_PORT = postgresPort
  const runningIds = docker(['ps', '--quiet'], true).trim().split(/\s+/).filter(Boolean)
  const occupied = runningIds.length
    ? docker(
        [
          'inspect',
          '--type',
          'container',
          '--format',
          '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"ports":{{json .NetworkSettings.Ports}}}',
          ...runningIds,
        ],
        true,
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((container) => container.project !== config.name)
    : []
  const stopIds = []
  for (const container of occupied) {
    const ports = Object.entries(container.ports ?? {}).flatMap(([target, bindings]) =>
      target.endsWith('/tcp')
        ? (bindings ?? [])
            .filter(
              (binding) =>
                ['', '0.0.0.0', '127.0.0.1', '::'].includes(binding.HostIp) &&
                binding.HostPort === String(postgresPort),
            )
            .map((binding) => binding.HostPort)
        : [],
    )
    if (!ports.length) continue
    if (
      !(await confirm(
        `Container ${container.name.replace(/^\//, '')} (${container.id}) occupies host port(s) ${[...new Set(ports)].join(', ')}. Stop it without removing its data?`,
      ))
    )
      throw new Error(
        'Setup cancelled: the configured ports remain occupied; no containers stopped.',
      )
    stopIds.push(container.id)
  }
  writeEnv(file, updated)
  // Compose receives only its resolved port; migration loading owns the env hierarchy.
  console.log('Updated .env from .env.example; existing values retained, obsolete keys removed.')

  run(root, environment, 'pnpm', ['install', '--frozen-lockfile'])
  if (stopIds.length) docker(['stop', ...stopIds])
  if (reset) docker([...compose, 'down', '--volumes', '--remove-orphans'])
  docker([...compose, 'up', '--detach', '--wait', 'postgres'])
  run(root, environment, 'pnpm', ['db:migrate'])

  console.log('PostgreSQL is ready and migrations are applied. Configure each app before pnpm dev.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup(dirname(dirname(fileURLToPath(import.meta.url)))).catch((error) => {
    console.error(`Setup failed: ${error.message}`)
    process.exitCode = 1
  })
}
