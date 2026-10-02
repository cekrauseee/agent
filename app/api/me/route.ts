import { eq } from "drizzle-orm";
import { ensureSpace, requireOwner } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { effectivePreferences } from "@/lib/models";
import { api, ApiError, json } from "@/lib/server/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return api(async () => {
    const owner = await requireOwner(request);
    const [profile] = await getDb().select().from(user).where(eq(user.id, owner));
    if (!profile) throw new ApiError(401, "Authentication required");
    const space = await ensureSpace(owner);
    return json({ id: profile.id, firstName: profile.firstName, lastName: profile.lastName,
      email: profile.email, image: profile.image, preferences: effectivePreferences(profile), spaceId: space.id });
  });
}
