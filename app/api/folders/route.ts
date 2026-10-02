import { requireOwner } from "@/lib/auth";
import { createFolder } from "@/lib/spaces";
import { api, json, readJson } from "@/lib/server/http";
export async function POST(request: Request) {
  return api(async () => { const owner = await requireOwner(request); return json(await createFolder(owner, await readJson(request)), 201); });
}
