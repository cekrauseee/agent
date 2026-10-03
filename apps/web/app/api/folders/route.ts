import { requireOwner } from '@agent/backend/auth'
import { createFolder } from '@agent/backend/spaces'
import { api, json, readJson } from '@agent/backend/server/http'
export async function POST(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await createFolder(owner, await readJson(request)), 201)
  })
}
