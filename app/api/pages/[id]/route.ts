import { requireOwner } from "@/lib/auth";
import { deletePage, getPage, updatePage, PAGE_BODY_LIMIT } from "@/lib/spaces";
import { api, json, readJson } from "@/lib/server/http";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return api(async () => json(await getPage(await requireOwner(request), (await context.params).id)));
}
export async function PATCH(request: Request, context: Context) {
  return api(async () => { const owner = await requireOwner(request); return json(await updatePage(owner, (await context.params).id, await readJson(request, PAGE_BODY_LIMIT))); });
}
export async function DELETE(request: Request, context: Context) {
  return api(async () => { await deletePage(await requireOwner(request), (await context.params).id); return json({ deleted: true }); });
}
