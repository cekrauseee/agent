import { requireOwner } from '@/lib/auth'
import { eventStream } from '@/lib/agent/stream'
import { api } from '@/lib/server/http'
type Context = { params: Promise<{ id: string; generationId: string }> }
export async function GET(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    const { id, generationId } = await context.params
    return eventStream(request, owner, id, generationId)
  })
}
