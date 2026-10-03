import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)
process.env.PORT = process.env.APP_PORT || process.env.PORT || '3000'
