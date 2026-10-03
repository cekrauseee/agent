import { requireOwner } from '@agent/backend/auth'
import { submitTurn } from '@agent/backend/agent'
import { api, json, readJson } from '@agent/backend/server/http'
type Context = { params: Promise<{ id: string; generationId: string }> }
export async function POST(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    const { id, generationId } = await context.params
    return json(
      await submitTurn(owner, id, await readJson(request), {
        kind: 'retry',
        targetId: generationId,
      }),
      202,
    )
  })
}
