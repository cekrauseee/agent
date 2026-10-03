import { deletionCleanup } from '@agent/backend/agent'
import { requireOwner } from '@agent/backend/auth'
import {
  deleteConversation,
  getConversation,
  updateConversation,
} from '@agent/backend/organization'
import { api, json, readJson } from '@agent/backend/server/http'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  return api(async () =>
    json(await getConversation(await requireOwner(request), (await context.params).id)),
  )
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    const owner = await requireOwner(request)
    return json(await updateConversation(owner, (await context.params).id, await readJson(request)))
  })
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    const receipt = await deleteConversation(await requireOwner(request), (await context.params).id)
    await deletionCleanup(receipt)
    return json({ deleted: true })
  })
}
