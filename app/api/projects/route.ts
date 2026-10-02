import { requireOwner } from "@/lib/auth";
import { createProject, listProjects, pagination } from "@/lib/organization";
import { api, json, readJson } from "@/lib/server/http";
export async function GET(request: Request) {
  return api(async () => json(await listProjects(await requireOwner(request), pagination(new URL(request.url).searchParams))));
}
export async function POST(request: Request) {
  return api(async () => { const owner = await requireOwner(request); return json(await createProject(owner, await readJson(request)), 201); });
}
