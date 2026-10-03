import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

/** Preserve raw quoting; native parsing verifies every retained assignment. */
export function mergeEnv(template, existing, defaults = {}) {
  const values = parseEnv(existing)
  const raw = new Map()
  const assignments =
    /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*('(?:[^']*)'|"(?:[^"]*)"|[^\r\n]*)/gm
  for (const match of existing.matchAll(assignments)) raw.set(match[1], match[2].trim())
  return (
    template
      .replace(/^(# )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm, (line, optional, key, fallback) => {
        if (optional && !(key in values)) return line
        if (values[key]?.trim() || optional) {
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

export function writeEnv(file, content) {
  const temporary = `${file}.setup-${randomUUID()}`
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    chmodSync(file, 0o600)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function prepareEnv(directory, defaults = {}) {
  const root = directory instanceof URL ? fileURLToPath(directory) : directory
  const template = readFileSync(join(root, '.env.example'), 'utf8')
  const file = join(root, '.env')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const previous = parseEnv(existing)
  const fields = parseEnv(template)
  for (const key of ['APP_PORT', 'POSTGRES_PORT']) {
    if (!(key in fields)) continue
    defaults[key] = previous[key] || process.env[key] || fields[key]
    if (!/^\d+$/.test(defaults[key]) || Number(defaults[key]) < 1 || Number(defaults[key]) > 65535)
      throw new Error(`${key} must be a valid port number.`)
  }
  if ('BETTER_AUTH_URL' in fields)
    defaults.BETTER_AUTH_URL ??= `http://localhost:${defaults.APP_PORT}`
  if ('DATABASE_URL' in fields && 'POSTGRES_PORT' in fields)
    defaults.DATABASE_URL ??= `postgresql://agent:agent-local@localhost:${defaults.POSTGRES_PORT}/agent`
  const updated = mergeEnv(template, existing, defaults)
  if ('BETTER_AUTH_SECRET' in fields && parseEnv(updated).BETTER_AUTH_SECRET.length < 32)
    throw new Error('Existing BETTER_AUTH_SECRET is too short; its value was not changed.')
  writeEnv(file, updated)
  console.log('Updated project .env from .env.example; existing values retained.')
}

export function workspaceRoot(directory) {
  const project = resolve(directory instanceof URL ? fileURLToPath(directory) : directory)
  let root = project
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root)
    if (parent === root) return project
    root = parent
  }
  return root
}

function environmentFiles(directory, mode) {
  const project = resolve(directory instanceof URL ? fileURLToPath(directory) : directory)
  const names = [
    `.env.${mode}.local`,
    ...(mode === 'test' ? [] : ['.env.local']),
    `.env.${mode}`,
    '.env',
  ]
  return [...new Set([project, workspaceRoot(project)])]
    .flatMap((scope) => names.map((name) => join(scope, name)))
    .filter((file) => existsSync(file))
}

/** Read the hierarchy without changing the caller's process. */
export function readEnv(directory, mode = process.env.NODE_ENV || 'development') {
  return Object.assign(
    {},
    ...environmentFiles(directory, mode)
      .reverse()
      .map((file) => parseEnv(readFileSync(file, 'utf8'))),
    process.env,
  )
}

/** Closest scope wins; native loading never replaces an inherited process value. */
export function loadEnv(directory, mode = process.env.NODE_ENV || 'development') {
  for (const file of environmentFiles(directory, mode)) process.loadEnvFile(file)
}
