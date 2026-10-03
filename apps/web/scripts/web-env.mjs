import { loadEnv } from '@agent/environment'

const explicitPort = process.env.APP_PORT || process.env.PORT
loadEnv(
  new URL('../', import.meta.url),
  process.env.NODE_ENV || (process.argv.includes('dev') ? 'development' : 'production'),
)
process.env.PORT = explicitPort || process.env.APP_PORT || process.env.PORT || '3000'
