import { requireOwner } from '@agent/backend/auth'
import { listSpace } from '@agent/backend/spaces'
import { api, json } from '@agent/backend/server/http'
export async function GET(request: Request) {
  return api(async () =>
    json(await listSpace(await requireOwner(request), new URL(request.url).searchParams)),
  )
}
