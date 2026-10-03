import { migrationsFolder } from '@agent/backend/db/migrations'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDatabase } from '@agent/backend/db'
import journal from '../drizzle/meta/_journal.json'

// Opt-in integration check creates and removes its own empty database, never existing tables.
test(
  'PostgreSQL migrations, integrity, concurrency and transactions',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    assert.ok(
      ['localhost', '127.0.0.1', 'postgres'].includes(url.hostname),
      'Integration checks require a local database',
    )
    const database = `persistence_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url.href })
    await admin.query(`CREATE DATABASE "${database}"`)
    url.pathname = `/${database}`
    const connection = createDatabase({ driver: 'postgres', url: url.href })
    const pool = new Pool({ connectionString: url.href })
    const q = (query: string, values: unknown[] = []) => pool.query(query, values)
    try {
      await migrate(connection.db, { migrationsFolder })
      await migrate(connection.db, { migrationsFolder })
      assert.equal(
        (await q('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count,
        journal.entries.length,
      )
      await q(
        `INSERT INTO "user" (id,name,email) VALUES ('a','A','a@example.test'),('b','B','b@example.test')`,
      )
      const project = (
        await q(`INSERT INTO project(owner_id,title) VALUES ('a','Project') RETURNING id`)
      ).rows[0].id
      await assert.rejects(
        q(`INSERT INTO conversation(owner_id,project_id,title) VALUES ('b',$1,'Private')`, [
          project,
        ]),
        /foreign key/,
      )
      const conversation = (
        await q(
          `INSERT INTO conversation(owner_id,project_id,title) VALUES ('a',$1,'Chat') RETURNING id`,
          [project],
        )
      ).rows[0].id
      await q('DELETE FROM project WHERE id=$1', [project])
      assert.equal(
        (await q('SELECT project_id FROM conversation WHERE id=$1', [conversation])).rows[0]
          .project_id,
        null,
      )
      const aSpace = (await q(`INSERT INTO space(owner_id) VALUES ('a') RETURNING id`)).rows[0].id
      const bSpace = (await q(`INSERT INTO space(owner_id) VALUES ('b') RETURNING id`)).rows[0].id
      await assert.rejects(q(`INSERT INTO space(owner_id) VALUES ('a')`), /unique/)
      const parent = (
        await q(`INSERT INTO folder(space_id,name) VALUES ($1,'Parent') RETURNING id`, [aSpace])
      ).rows[0].id
      const child = (
        await q(`INSERT INTO folder(space_id,parent_id,name) VALUES ($1,$2,'Child') RETURNING id`, [
          aSpace,
          parent,
        ])
      ).rows[0].id
      await assert.rejects(
        q(`INSERT INTO folder(space_id,parent_id,name) VALUES ($1,$2,'Wrong')`, [bSpace, parent]),
        /foreign key/,
      )
      await assert.rejects(
        q(`INSERT INTO page(space_id,folder_id,title) VALUES ($1,$2,'Wrong')`, [bSpace, child]),
        /foreign key/,
      )
      await assert.rejects(
        q('UPDATE folder SET parent_id=id WHERE id=$1', [parent]),
        /check constraint/,
      )
      await q(
        `INSERT INTO page(space_id,folder_id,title,markdown) VALUES ($1,$2,'Nested','# Private')`,
        [aSpace, child],
      )
      const root = (
        await q(`INSERT INTO page(space_id,title) VALUES ($1,'Root') RETURNING id`, [aSpace])
      ).rows[0].id
      await q('DELETE FROM folder WHERE id=$1', [parent])
      assert.equal((await q('SELECT count(*)::int AS count FROM folder')).rows[0].count, 0)
      assert.deepEqual(
        (await q('SELECT id FROM page')).rows.map((r) => r.id),
        [root],
      )
      const request = randomUUID()
      await q(
        `INSERT INTO message(conversation_id,turn,role,request_id,text) VALUES ($1,0,'user',$2,'hello')`,
        [conversation, request],
      )
      await assert.rejects(
        q(`INSERT INTO message(conversation_id,turn,role,request_id) VALUES ($1,0,'user',$2)`, [
          conversation,
          randomUUID(),
        ]),
        /unique/,
      )
      await assert.rejects(
        q(`INSERT INTO message(conversation_id,turn,role,request_id) VALUES ($1,1,'user',$2)`, [
          conversation,
          request,
        ]),
        /unique/,
      )
      await assert.rejects(
        q(
          `INSERT INTO message(conversation_id,turn,role,request_id,generation_id,model,effort) VALUES ($1,0,'assistant',$2,$3,'test','medium')`,
          [conversation, randomUUID(), randomUUID()],
        ),
        /check constraint/,
      )
      const insertGeneration = (turn: number) =>
        q(
          `INSERT INTO message(conversation_id,turn,role,request_id,generation_id,generation_version,status,model,effort) VALUES ($1,$2,'assistant',$3,$4,1,'pending','test','medium') RETURNING generation_id`,
          [conversation, turn, randomUUID(), randomUUID()],
        )
      const admissions = await Promise.allSettled([insertGeneration(0), insertGeneration(1)])
      assert.equal(admissions.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(admissions.filter((r) => r.status === 'rejected').length, 1)
      const active = admissions.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof q>>
      >
      const generation = active.value.rows[0].generation_id
      await q('UPDATE conversation SET generation_version=2,current_generation_id=$2 WHERE id=$1', [
        conversation,
        randomUUID(),
      ])
      // The generation executor must use both current ID and version in its short completion transaction.
      assert.equal(
        (
          await q(
            `UPDATE conversation SET provider_response_id='stale' WHERE id=$1 AND current_generation_id=$2 AND generation_version=1 RETURNING id`,
            [conversation, generation],
          )
        ).rowCount,
        0,
      )
      await assert.rejects(
        connection.db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE conversation SET title = 'rollback' WHERE id = ${conversation}`,
          )
          throw new Error('rollback requested')
        }),
        /rollback requested/,
      )
      assert.equal(
        (await q('SELECT title FROM conversation WHERE id=$1', [conversation])).rows[0].title,
        'Chat',
      )
      await connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE conversation SET title = 'committed' WHERE id = ${conversation}`,
        )
      })
      assert.equal(
        (await q('SELECT title FROM conversation WHERE id=$1', [conversation])).rows[0].title,
        'committed',
      )
      await q('DELETE FROM conversation WHERE id=$1', [conversation])
      assert.equal((await q('SELECT count(*)::int AS count FROM message')).rows[0].count, 0)
      await q(
        `INSERT INTO session(id,user_id,token,expires_at) VALUES ('s','a','token',now()+interval '1 day')`,
      )
      await q(
        `INSERT INTO account(id,user_id,account_id,provider_id) VALUES ('g','a','external','google')`,
      )
      await q(`DELETE FROM "user" WHERE id='a'`)
      for (const table of ['space', 'page', 'session', 'account']) {
        assert.equal(
          (
            await q(
              `SELECT count(*)::int AS count FROM "${table}"${table === 'space' ? " WHERE owner_id='a'" : ''}`,
            )
          ).rows[0].count,
          0,
        )
      }
    } finally {
      await connection.close()
      await pool.end()
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.end()
    }
  },
)

test('Neon driver can be configured without credentials or connections', async () => {
  const connection = createDatabase({
    driver: 'neon',
    url: 'postgresql://test:test@example.invalid/test',
  })
  assert.equal(typeof connection.db.transaction, 'function')
  await connection.close()
})
