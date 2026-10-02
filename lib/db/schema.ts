import { sql } from "drizzle-orm";
import { pgTable, text, boolean, timestamp, uuid, integer, jsonb, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });
const timestamps = () => ({ createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow() });
const id = () => uuid("id").primaryKey().defaultRandom();

// Better Auth owns its string IDs and required fields; extensions are configured in auth.
export const user = pgTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false), image: text("image"),
  firstName: text("first_name"), lastName: text("last_name"),
  preferredModel: text("preferred_model"), preferredEffort: text("preferred_effort"), ...timestamps(),
});
export const session = pgTable("session", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(), expiresAt: time("expires_at").notNull(),
  ipAddress: text("ip_address"), userAgent: text("user_agent"), ...timestamps(),
}, t => [index("session_user_idx").on(t.userId)]);
export const account = pgTable("account", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: time("access_token_expires_at"), refreshTokenExpiresAt: time("refresh_token_expires_at"),
  scope: text("scope"), password: text("password"), ...timestamps(),
}, t => [index("account_user_idx").on(t.userId), unique("account_provider_identity_unique").on(t.providerId, t.accountId)]);
export const verification = pgTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: time("expires_at").notNull(), ...timestamps(),
}, t => [index("verification_identifier_idx").on(t.identifier)]);
export const projects = pgTable("project", {
  id: id(), ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(), ...timestamps(),
}, t => [unique("project_id_owner_unique").on(t.id, t.ownerId), index("project_owner_updated_idx").on(t.ownerId, t.updatedAt, t.id)]);
export const conversations = pgTable("conversation", {
  id: id(), ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(), nextTurn: integer("next_turn").notNull().default(0),
  generationVersion: integer("generation_version").notNull().default(0), currentGenerationId: uuid("current_generation_id"),
  providerResponseId: text("provider_response_id"), context: jsonb("context").$type<unknown[]>(), ...timestamps(),
}, t => [
  foreignKey({ columns: [t.projectId, t.ownerId], foreignColumns: [projects.id, projects.ownerId], name: "conversation_project_owner_fk" }),
  index("conversation_owner_updated_idx").on(t.ownerId, t.updatedAt, t.id), index("conversation_project_idx").on(t.projectId),
  check("conversation_counters_check", sql`${t.nextTurn} >= 0 AND ${t.generationVersion} >= 0`),
]);
export const messages = pgTable("message", {
  id: id(), conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  turn: integer("turn").notNull(), role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull().default(""), requestId: uuid("request_id").notNull(),
  generationId: uuid("generation_id").unique(), generationVersion: integer("generation_version"),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] }).notNull().default("completed"),
  model: text("model"), effort: text("effort"), usage: jsonb("usage"), citations: jsonb("citations"),
  providerResponseId: text("provider_response_id"), providerOutput: jsonb("provider_output").$type<unknown[]>(),
  contextBefore: jsonb("context_before").$type<unknown[]>(), responseIdBefore: text("response_id_before"),
  streamCursor: integer("stream_cursor").notNull().default(-1), error: text("error"), ...timestamps(),
}, t => [
  unique("message_turn_role_unique").on(t.conversationId, t.turn, t.role),
  unique("message_request_role_unique").on(t.conversationId, t.requestId, t.role),
  uniqueIndex("message_one_active_generation").on(t.conversationId).where(sql`${t.role} = 'assistant' AND ${t.status} IN ('pending', 'running')`),
  check("message_role_check", sql`${t.role} IN ('user', 'assistant')`),
  check("message_status_check", sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
  check("message_turn_check", sql`${t.turn} >= 0 AND ${t.streamCursor} >= -1`),
  check("message_generation_check", sql`(${t.role} = 'user' AND ${t.status} = 'completed' AND ${t.generationId} IS NULL) OR (${t.role} = 'assistant' AND ${t.generationId} IS NOT NULL AND ${t.generationVersion} IS NOT NULL AND ${t.generationVersion} >= 0 AND ${t.model} IS NOT NULL AND ${t.effort} IS NOT NULL)`),
]);
export const spaces = pgTable("space", {
  id: id(), ownerId: text("owner_id").notNull().unique().references(() => user.id, { onDelete: "cascade" }), ...timestamps(),
});
export const folders = pgTable("folder", {
  id: id(), spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id"), name: text("name").notNull(), ...timestamps(),
}, t => [unique("folder_id_space_unique").on(t.id, t.spaceId),
  foreignKey({ columns: [t.parentId, t.spaceId], foreignColumns: [t.id, t.spaceId], name: "folder_parent_space_fk" }).onDelete("cascade"),
  check("folder_not_self_parent", sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`), index("folder_space_parent_idx").on(t.spaceId, t.parentId, t.id)]);
export const pages = pgTable("page", {
  id: id(), spaceId: uuid("space_id").notNull().references(() => spaces.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id"), title: text("title").notNull(), markdown: text("markdown").notNull().default(""), ...timestamps(),
}, t => [foreignKey({ columns: [t.folderId, t.spaceId], foreignColumns: [folders.id, folders.spaceId], name: "page_folder_space_fk" }).onDelete("cascade"),
  index("page_space_folder_idx").on(t.spaceId, t.folderId, t.id)]);

// Small durable worker queue. No content/FK: cleanup survives conversation deletion.
export const generationJobs = pgTable("generation_job", {
  id: uuid("id").primaryKey(), providerResponseId: text("provider_response_id"),
  state: text("state", { enum: ["pending", "creating", "monitoring", "done", "ambiguous"] }).notNull().default("pending"),
  cleanup: boolean("cleanup").notNull().default(false), leaseUntil: time("lease_until"), ...timestamps(),
}, t => [index("generation_job_work_idx").on(t.state, t.leaseUntil)]);
export const turnRequests = pgTable("turn_request", {
  id: id(), conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(), fingerprint: text("fingerprint").notNull(), generationId: uuid("generation_id").notNull(),
}, t => [unique("turn_request_conversation_unique").on(t.conversationId, t.requestId)]);
export const generationEvents = pgTable("generation_event", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  type: text("type").notNull(), data: jsonb("data").$type<Record<string, unknown>>().notNull(),
}, t => [index("generation_event_message_cursor_idx").on(t.messageId, t.id)]);
export const paidRequests = pgTable("paid_request", {
  id: uuid("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), activeUntil: time("active_until").notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [index("paid_request_owner_time_idx").on(t.ownerId, t.createdAt)]);
