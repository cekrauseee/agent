import { eq } from "drizzle-orm";
import { requireOwner } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { effectivePreferences, validatePreferences } from "@/lib/models";
import { api, ApiError, json, readJson } from "@/lib/server/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request);
    const [profile] = await getDb().select().from(user).where(eq(user.id, owner));
    if (!profile) throw new ApiError(401, "Authentication required");
    return json(effectivePreferences(profile));
  });
}
export async function PATCH(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request);
    const body = await readJson(request);
    let preferences;
    try { preferences = validatePreferences(body); }
    catch { throw new ApiError(400, "Unsupported model or reasoning effort"); }
    const [updated] = await getDb().update(user).set({ preferredModel: preferences.model, preferredEffort: preferences.effort, updatedAt: new Date() }).where(eq(user.id, owner)).returning({ id: user.id });
    if (!updated) throw new ApiError(401, "Authentication required");
    return json(preferences);
  });
}
