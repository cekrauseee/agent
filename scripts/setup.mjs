import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

/** Preserve raw quoting/interpolation; native parsing verifies each retained assignment. */
export function mergeEnv(template, existing, defaults = {}) {
  const values = parseEnv(existing)
  const raw = new Map()
  const assignments =
    /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*('(?:[^']*)'|"(?:[^"]*)"|[^\r\n]*)/gm
  for (const match of existing.matchAll(assignments)) raw.set(match[1], match[2].trim())
  return (
    template
      .replace(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm, (_, key, fallback) => {
        if (values[key]?.trim()) {
          const assignment = `${key}=${raw.get(key) ?? ''}`
          if (parseEnv(assignment)[key] !== values[key])
            throw new Error(`Cannot safely preserve ${key}; correct its .env quoting before setup.`)
          return assignment
        }
        const value =
          defaults[key] ??
          (key === 'BETTER_AUTH_SECRET' ? randomBytes(32).toString('hex') : fallback)
        return `${key}=${value}`
      })
      .trimEnd() + '\n'
  )
}

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
  const environment = { ...process.env }
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

  const file = join(root, '.env')
  const template = readFileSync(join(root, '.env.example'), 'utf8')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const previous = parseEnv(existing)
  const appPort = previous.APP_PORT || environment.APP_PORT || '3000'
  const postgresPort = previous.POSTGRES_PORT || environment.POSTGRES_PORT || '5432'
  for (const port of [appPort, postgresPort]) {
    if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('APP_PORT and POSTGRES_PORT must be valid port numbers.')
  }
  const updated = mergeEnv(template, existing, {
    APP_PORT: appPort,
    POSTGRES_PORT: postgresPort,
    BETTER_AUTH_URL: `http://localhost:${appPort}`,
    DATABASE_URL: `postgresql://agent:agent-local@localhost:${postgresPort}/agent`,
  })
  if (parseEnv(updated).BETTER_AUTH_SECRET.length < 32)
    throw new Error(
      'Existing BETTER_AUTH_SECRET is too short; provide at least 32 characters in .env. Its value was not changed.',
    )
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
                [String(appPort), String(postgresPort)].includes(binding.HostPort),
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
  const temporary = `${file}.setup-${randomUUID()}`
  try {
    writeFileSync(temporary, updated, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
  // Compose and host commands load .env directly; inherited keys must not override the file.
  for (const key of Object.keys(parseEnv(template))) delete environment[key]
  compose.push('--env-file', file)
  console.log('Updated .env from .env.example; existing values retained, obsolete keys removed.')

  run(root, environment, 'pnpm', ['install', '--frozen-lockfile'])
  if (stopIds.length) docker(['stop', ...stopIds])
  if (reset) docker([...compose, 'down', '--volumes', '--remove-orphans'])
  docker([...compose, 'up', '--detach', '--wait', 'postgres'])
  run(root, environment, 'pnpm', ['db:migrate'])

  const valuesAfter = parseEnv(updated)
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OPENAI_API_KEY'].filter(
    (key) => !valuesAfter[key]?.trim(),
  )
  console.log('PostgreSQL is ready and migrations are applied.')
  if (missing.length)
    console.log(
      `Fill these existing service credentials in .env for login/AI: ${missing.join(', ')}. Restart pnpm dev after changes.`,
    )
  console.log(`Run pnpm dev to start the host app and worker. API: http://localhost:${appPort}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup(dirname(dirname(fileURLToPath(import.meta.url)))).catch((error) => {
    console.error(`Setup failed: ${error.message}`)
    process.exitCode = 1
  })
}
