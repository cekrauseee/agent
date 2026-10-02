import { requireOwner } from '@/lib/auth'
import { listSpace } from '@/lib/spaces'
import { api, json } from '@/lib/server/http'
export async function GET(request: Request) {
  return api(async () =>
    json(await listSpace(await requireOwner(request), new URL(request.url).searchParams)),
  )
}
