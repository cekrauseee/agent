import { requireOwner } from '@agent/backend/auth'
import { MODEL_CATALOG, DEFAULT_PREFERENCES } from '@agent/backend/models'
import { api, json } from '@agent/backend/server/http'

export const runtime = 'nodejs'
export async function GET(request: Request) {
  return api(async () => {
    await requireOwner(request)
    return json({ models: MODEL_CATALOG, defaults: DEFAULT_PREFERENCES })
  })
}
