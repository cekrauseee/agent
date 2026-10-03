import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { withTestDatabase } from '../src/database'

test(
  'temporary database cleanup restores configuration even after a failure',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const saved = { ...process.env }
    let first = ''
    await assert.rejects(
      withTestDatabase(async (db, url) => {
        first = url
        await db.execute(sql`select 1`)
        throw new Error('controlled failure')
      }),
      /controlled failure/,
    )
    assert.deepEqual(process.env, saved)
    await withTestDatabase(async (db, url) => {
      assert.notEqual(url, first)
      await db.execute(sql`select 1`)
    })
    assert.deepEqual(process.env, saved)
  },
)
