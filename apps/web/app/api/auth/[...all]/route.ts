import { getAuth } from '@agent/backend/auth'
import { toNextJsHandler } from 'better-auth/next-js'

export const runtime = 'nodejs'
export const { GET, POST } = toNextJsHandler((request: Request) => getAuth().handler(request))
