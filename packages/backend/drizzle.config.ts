import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: relative(process.cwd(), fileURLToPath(new URL('./src/db/schema.ts', import.meta.url))),
  out: relative(process.cwd(), fileURLToPath(new URL('./drizzle', import.meta.url))),
})
