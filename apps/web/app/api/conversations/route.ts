import { requireOwner } from '@agent/backend/auth'
import {
  createConversation,
  listConversations,
  pagination,
  uuid,
} from '@agent/backend/organization'
import { api, json, readJson } from '@agent/backend/server/http'
export async function GET(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request)
    const params = new URL(request.url).searchParams
    const projectId = params.has('projectId')
      ? params.get('projectId') === 'null'
        ? null
        : uuid(params.get('projectId'))
      : undefined
    return json(await listConversations(owner, pagination(params), projectId))
  })
}
export async function POST(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await createConversation(owner, await readJson(request)), 201)
  })
}
