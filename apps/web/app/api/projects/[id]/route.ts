import { requireOwner } from '@agent/backend/auth'
import { deleteProject, getProject, renameProject } from '@agent/backend/organization'
import { api, json, readJson } from '@agent/backend/server/http'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  return api(async () =>
    json(await getProject(await requireOwner(request), (await context.params).id)),
  )
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await renameProject(owner, (await context.params).id, await readJson(request)))
  })
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    await deleteProject(await requireOwner(request), (await context.params).id)
    return json({ deleted: true })
  })
}
