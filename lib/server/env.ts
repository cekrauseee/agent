import 'server-only'

/** Read credentials when a service is used, never during module initialization. */
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing server configuration: ${name}`)
  return value
}

export function databaseConfig() {
  const vercelDeployment = ['preview', 'production'].includes(process.env.VERCEL_ENV ?? '')
  const driver = process.env.DATABASE_DRIVER?.trim() || (vercelDeployment ? 'neon' : 'postgres')
  if (driver !== 'postgres' && driver !== 'neon') {
    throw new Error('DATABASE_DRIVER must be postgres or neon')
  }
  const url = requiredEnv('DATABASE_URL')
  if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL')
  }
  return { driver, url }
}
