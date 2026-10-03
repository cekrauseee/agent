import { submitTurn } from '@agent/backend/agent'
import { requireOwner } from '@agent/backend/auth'
import { listMessages, pagination } from '@agent/backend/organization'
import { api, json, readJson } from '@agent/backend/server/http'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () =>
    json(
      await listMessages(
        await requireOwner(request),
        (await context.params).id,
        pagination(new URL(request.url).searchParams),
      ),
    ),
  )
}

export async function POST(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(
      await submitTurn(owner, (await context.params).id, await readJson(request, 400_000)),
      202,
    )
  })
}
