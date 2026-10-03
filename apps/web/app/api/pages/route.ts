import { requireOwner } from '@agent/backend/auth'
import { createPage, PAGE_BODY_LIMIT } from '@agent/backend/spaces'
import { api, json, readJson } from '@agent/backend/server/http'
export async function POST(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await createPage(owner, await readJson(request, PAGE_BODY_LIMIT)), 201)
  })
}
