import { requireOwner } from '@agent/backend/auth'
import { createProject, listProjects, pagination } from '@agent/backend/organization'
import { api, json, readJson } from '@agent/backend/server/http'
export async function GET(request: Request) {
  return api(async () =>
    json(
      await listProjects(
        await requireOwner(request),
        pagination(new URL(request.url).searchParams),
      ),
    ),
  )
}
export async function POST(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await createProject(owner, await readJson(request)), 201)
  })
}
