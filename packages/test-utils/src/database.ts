import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDatabase, getDb, type Database } from '@agent/backend/db'
import { migrationsFolder } from '@agent/backend/db/migrations'

/** Create/drop only a new local database, restoring the caller's environment and pool. */
export async function withTestDatabase<T>(run: (db: Database, url: string) => Promise<T>) {
  const saved = { ...process.env }
  const url = new URL(process.env.TEST_DATABASE_URL!)
  assert.ok(['localhost', '127.0.0.1', 'postgres'].includes(url.hostname))
  const name = `agent_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url.href })
  let created = false
  const globalDb = globalThis as typeof globalThis & {
    agentDatabase?: ReturnType<typeof createDatabase>
  }
  try {
    await admin.query(`CREATE DATABASE "${name}"`)
    created = true
    url.pathname = `/${name}`
    Object.assign(process.env, { DATABASE_URL: url.href, DATABASE_DRIVER: 'postgres' })
    const db = getDb()
    await migrate(db, { migrationsFolder })
    return await run(db, url.href)
  } finally {
    try {
      await globalDb.agentDatabase?.close()
    } finally {
      delete globalDb.agentDatabase
      try {
        if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
      } finally {
        await admin.end()
        process.env = saved
      }
    }
  }
}
