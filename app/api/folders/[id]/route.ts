import { requireOwner } from "@/lib/auth";
import { deleteFolder, getFolder, updateFolder } from "@/lib/spaces";
import { api, json, readJson } from "@/lib/server/http";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => json(await getFolder(await requireOwner(request), (await context.params).id)));
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => { const owner = await requireOwner(request); return json(await updateFolder(owner, (await context.params).id, await readJson(request))); });
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => { await deleteFolder(await requireOwner(request), (await context.params).id); return json({ deleted: true }); });
}
