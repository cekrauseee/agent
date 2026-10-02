import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../db";
import * as schema from "../db/schema";
import { requiredEnv } from "../server/env";
import { ApiError } from "../server/http";

export function authOrigin() {
  const url = new URL(requiredEnv("BETTER_AUTH_URL"));
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP is allowed on localhost)");
  }
  return url.origin;
}

export async function ensureSpace(ownerId: string, db: Database = getDb()) {
  const [created] = await db.insert(schema.spaces).values({ ownerId }).onConflictDoNothing({ target: schema.spaces.ownerId }).returning();
  if (created) return created;
  const [existing] = await db.select().from(schema.spaces).where(eq(schema.spaces.ownerId, ownerId));
  if (!existing) throw new Error("Space provisioning failed");
  return existing;
}

export function googleProfile(profile: { name?: string; given_name?: string; family_name?: string; email: string; picture?: string }) {
  return {
    name: profile.name || profile.given_name || profile.email,
    firstName: profile.given_name || null,
    lastName: profile.family_name || null,
    email: profile.email,
    image: profile.picture || undefined,
  };
}

export function createAuth(db: Database = getDb()) {
  const baseURL = authOrigin();
  const secret = requiredEnv("BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  return betterAuth({
    baseURL, secret, trustedOrigins: [baseURL],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: false },
    disabledPaths: ["/update-user"],
    socialProviders: {
      google: {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"), clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
        scope: ["openid", "email", "profile"], mapProfileToUser: googleProfile,
      },
    },
    user: { additionalFields: {
      firstName: { type: "string", required: false, input: false },
      lastName: { type: "string", required: false, input: false },
      preferredModel: { type: "string", required: false, input: false },
      preferredEffort: { type: "string", required: false, input: false },
    } },
    session: { cookieCache: { enabled: false }, expiresIn: 60 * 60 * 24 * 7 },
    advanced: { useSecureCookies: baseURL.startsWith("https:"), defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    databaseHooks: {
      user: { create: { after: async user => { await ensureSpace(user.id, db); } } },
      session: { create: { before: async session => { await ensureSpace(session.userId, db); } } },
    },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() { return auth ??= createAuth(); }

export function requireOrigin(request: Request) {
  if (request.headers.get("origin") !== authOrigin()) throw new ApiError(403, "Untrusted request origin");
}

/** Every private route derives ownership from the validated database-backed session. */
export async function requireOwner(request: Request, authInstance = getAuth()) {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) requireOrigin(request);
  const session = await authInstance.api.getSession({ headers: request.headers });
  if (!session) throw new ApiError(401, "Authentication required");
  return session.user.id;
}
