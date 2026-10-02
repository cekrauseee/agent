import { requireOwner } from "@/lib/auth";
import { submitTurn } from "@/lib/agent";
import { api, json, readJson } from "@/lib/server/http";
type Context = { params: Promise<{ id: string; generationId: string }> };
export async function POST(request: Request, context: Context) {
  return api(async () => { const owner = await requireOwner(request); const { id, generationId } = await context.params; return json(await submitTurn(owner, id, await readJson(request), { kind: "retry", targetId: generationId }), 202); });
}
