import { requireOwner } from '@agent/backend/auth'
import { getGeneration } from '@agent/backend/agent'
import { api, json } from '@agent/backend/server/http'
type Context = { params: Promise<{ id: string; generationId: string }> }
export async function GET(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    const { id, generationId } = await context.params
    return json(await getGeneration(owner, id, generationId))
  })
}
