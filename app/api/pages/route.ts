import { requireOwner } from "@/lib/auth";
import { createPage, PAGE_BODY_LIMIT } from "@/lib/spaces";
import { api, json, readJson } from "@/lib/server/http";
export async function POST(request: Request) {
  return api(async () => { const owner = await requireOwner(request); return json(await createPage(owner, await readJson(request, PAGE_BODY_LIMIT)), 201); });
}
