import { requireOwner } from '@/lib/auth'
import { MODEL_CATALOG, DEFAULT_PREFERENCES } from '@/lib/models'
import { api, json } from '@/lib/server/http'

export const runtime = 'nodejs'
export async function GET(request: Request) {
  return api(async () => {
    await requireOwner(request)
    return json({ models: MODEL_CATALOG, defaults: DEFAULT_PREFERENCES })
  })
}
