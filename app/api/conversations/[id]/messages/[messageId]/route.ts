import { requireOwner } from "@/lib/auth";
import { submitTurn } from "@/lib/agent";
import { api, json, readJson } from "@/lib/server/http";
type Context = { params: Promise<{ id: string; messageId: string }> };
export async function PATCH(request: Request, context: Context) {
  return api(async () => { const owner = await requireOwner(request); const { id, messageId } = await context.params;
    return json(await submitTurn(owner, id, await readJson(request, 400_000), { kind: "replace", targetId: messageId }), 202); });
}
