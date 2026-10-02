import { submitTurn } from '@/lib/agent'
import { requireOwner } from '@/lib/auth'
import { listMessages, pagination } from '@/lib/organization'
import { api, json, readJson } from '@/lib/server/http'
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
