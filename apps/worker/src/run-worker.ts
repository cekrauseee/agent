import { setTimeout } from 'node:timers/promises'
import { createDatabase } from '@agent/backend/db'
import { getOpenAI } from '@agent/backend/server/openai'
import { reconcile } from './worker'

const connection = createDatabase()
let stopping = false
process.on('SIGTERM', () => {
  stopping = true
})
process.on('SIGINT', () => {
  stopping = true
})
async function main() {
  try {
    while (!stopping) {
      try {
        await reconcile(getOpenAI(), connection.db)
      } catch (error) {
        console.error(
          'Generation worker unavailable',
          error instanceof Error ? error.name : 'UnknownError',
        )
      }
      await setTimeout(2000)
    }
  } finally {
    await connection.close()
  }
}
main().catch(() => {
  console.error('Generation worker stopped')
  process.exitCode = 1
})
