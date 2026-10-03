import 'server-only'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
export { OpenAI }
import { and, count, eq, gt, lt, sql } from 'drizzle-orm'
import { getDb, type Database, type Transaction } from '../db'
import { paidRequests } from '../db/schema'
import { ApiError } from './http'
import { requiredEnv } from './env'

let client: OpenAI | undefined
export function getOpenAI() {
  // A timed-out creation is ambiguous; automatic paid retries can duplicate it.
  return (client ??= new OpenAI({
    apiKey: requiredEnv('OPENAI_API_KEY'),
    maxRetries: 0,
    timeout: 60_000,
  }))
}
export async function reservePaid(ownerId: string, id: string, kind: string, tx: Transaction) {
  // ponytail: one short SQL lock for shared limits; partition if measured contention warrants it.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(719001)`)
  await tx
    .delete(paidRequests)
    .where(
      and(
        lt(paidRequests.createdAt, sql`now() - interval '1 hour'`),
        lt(paidRequests.activeUntil, sql`now()`),
      ),
    )
  const [recent] = await tx
    .select({ n: count() })
    .from(paidRequests)
    .where(
      and(
        eq(paidRequests.ownerId, ownerId),
        gt(paidRequests.createdAt, sql`now() - interval '1 minute'`),
      ),
    )
  const [own] = await tx
    .select({ n: count() })
    .from(paidRequests)
    .where(and(eq(paidRequests.ownerId, ownerId), gt(paidRequests.activeUntil, sql`now()`)))
  const [global] = await tx
    .select({ n: count() })
    .from(paidRequests)
    .where(gt(paidRequests.activeUntil, sql`now()`))
  if (recent.n >= 10 || own.n >= 3 || global.n >= 20)
    throw new ApiError(429, 'Paid request limit reached; try again later')
  await tx
    .insert(paidRequests)
    .values({ id, ownerId, kind, activeUntil: sql`now() + interval '30 minutes'` })
}
export async function releasePaid(id: string, db: Database | Transaction = getDb()) {
  await db
    .update(paidRequests)
    .set({ activeUntil: sql`now()` })
    .where(eq(paidRequests.id, id))
}
/** Call only after session/origin/input authorization. Audio is not stored here. */
export async function withPaidRequest<T>(
  ownerId: string,
  kind: string,
  operation: () => Promise<T>,
  db: Database = getDb(),
): Promise<T> {
  const id = randomUUID()
  await db.transaction((tx) => reservePaid(ownerId, id, kind, tx))
  try {
    return await operation()
  } finally {
    await releasePaid(id, db)
  }
}
