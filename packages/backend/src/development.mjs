import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

/** Initial local defaults only; each app keeps its own runtime configuration. */
export function databaseDefaults() {
  const file = new URL('../.env', import.meta.url)
  const values = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { DATABASE_DRIVER: values.DATABASE_DRIVER, DATABASE_URL: values.DATABASE_URL }
}
