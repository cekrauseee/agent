import { migrate as postgresMigrate } from 'drizzle-orm/node-postgres/migrator'
import { migrate as neonMigrate } from 'drizzle-orm/neon-serverless/migrator'
import { databaseConfig } from '../server/env'
import { createDatabase } from './index'

async function main() {
  const config = databaseConfig()
  const connection = createDatabase(config)
  try {
    // Both migrators use interactive transactions, including for PostgreSQL DDL.
    const migrate = config.driver === 'neon' ? neonMigrate : postgresMigrate
    await migrate(connection.db, { migrationsFolder: 'drizzle' })
    console.log('Database migrations applied')
  } finally {
    await connection.close()
  }
}
main().catch(() => {
  console.error('Database migration failed; check connectivity and migration compatibility')
  process.exitCode = 1
})
