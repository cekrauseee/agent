import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "../db";
import { conversations, generationJobs, messages, projects } from "../db/schema";
import { ApiError } from "../server/http";

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, "Invalid identifier");
  return value.toLowerCase();
}
export function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, "Invalid fields");
  return value as Record<string, unknown>;
}
export function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new ApiError(400, "Title must contain 1–200 characters");
  return value.trim();
}
export function initialTitle(text?: string) { return text?.trim().replace(/\s+/g, " ").slice(0, 200) || "New conversation"; }
export function pagination(params: URLSearchParams) {
  const raw = params.get("limit") ?? "50";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new ApiError(400, "Limit must be between 1 and 100");
  return { limit: Number(raw), after: params.has("after") ? uuid(params.get("after")) : undefined };
}
const owned = (table: typeof projects | typeof conversations, ownerId: string, id: string) => and(eq(table.id, uuid(id)), eq(table.ownerId, ownerId));
function found<T>(row: T | undefined): T { if (!row) throw new ApiError(404, "Resource not found"); return row; }
const projectFields = { id: projects.id, title: projects.title, createdAt: projects.createdAt, updatedAt: projects.updatedAt };
const conversationFields = { id: conversations.id, projectId: conversations.projectId, title: conversations.title, createdAt: conversations.createdAt, updatedAt: conversations.updatedAt };
export function publicConversation(row: typeof conversations.$inferSelect) {
  const { id, projectId, title, createdAt, updatedAt } = row;
  return { id, projectId, title, createdAt, updatedAt };
}
export function publicMessage(row: typeof messages.$inferSelect) {
  const { id, turn, role, text, status, model, effort, generationId, streamCursor, createdAt, updatedAt } = row;
  // Only public URL citation annotations cross the HTTP boundary.
  const citations = Array.isArray(row.citations) ? row.citations.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    if (typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
    try { const url = new URL(item.url); if (url.username || url.password) return []; } catch { return []; }
    return [{ type: "url_citation", url: item.url, title: typeof item.title === "string" ? item.title : "",
      ...(Number.isInteger(item.start_index) && Number.isInteger(item.end_index) ? { start_index: item.start_index, end_index: item.end_index } : {}) }];
  }) : [];
  return { id, turn, role, text, status, model, effort, generationId, streamCursor, citations, createdAt, updatedAt };
}

export async function getProject(ownerId: string, id: string, db: Database = getDb()) {
  return found((await db.select(projectFields).from(projects).where(owned(projects, ownerId, id)))[0]);
}
export async function listProjects(ownerId: string, page: ReturnType<typeof pagination>, db: Database = getDb()) {
  const cursor = page.after ? await getProject(ownerId, page.after, db) : null;
  const rows = await db.select(projectFields).from(projects).where(and(eq(projects.ownerId, ownerId), cursor ? sql`(${projects.createdAt}, ${projects.id}) > (SELECT created_at, id FROM project WHERE id = ${cursor.id})` : undefined)).orderBy(asc(projects.createdAt), asc(projects.id)).limit(page.limit + 1);
  return { projects: rows.slice(0, page.limit), nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null };
}
export async function createProject(ownerId: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ["title"]);
  return (await db.insert(projects).values({ ownerId, title: title(body.title) }).returning(projectFields))[0];
}
export async function renameProject(ownerId: string, id: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ["title"]);
  return found((await db.update(projects).set({ title: title(body.title), updatedAt: new Date() }).where(owned(projects, ownerId, id)).returning(projectFields))[0]);
}
export async function deleteProject(ownerId: string, id: string, db: Database = getDb()) {
  found((await db.delete(projects).where(owned(projects, ownerId, id)).returning({ id: projects.id }))[0]);
}

/** Agent uses this short transaction lock for creating/replacing turns and guarded progress writes. */
export async function lockConversation(tx: Transaction, ownerId: string, id: string) {
  return found((await tx.select().from(conversations).where(owned(conversations, ownerId, id)).for("update"))[0]);
}
async function ownProject(tx: Transaction, ownerId: string, id: string) {
  found((await tx.select({ id: projects.id }).from(projects).where(owned(projects, ownerId, id)).for("share"))[0]);
}
export async function getConversation(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async tx => {
    const row = await lockConversation(tx, ownerId, id);
    const [latest] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, row.id), eq(messages.role, "user"))).orderBy(desc(messages.turn)).limit(1);
    const [generation] = row.currentGenerationId ? await tx.select().from(messages).where(and(eq(messages.conversationId, row.id), eq(messages.generationId, row.currentGenerationId))).limit(1) : [];
    return { ...publicConversation(row), lastEditableUserMessageId: latest?.id ?? null, currentGeneration: generation ? publicMessage(generation) : null };
  });
}
export async function listConversations(ownerId: string, page: ReturnType<typeof pagination>, projectId?: string | null, db: Database = getDb()) {
  const cursor = page.after ? found((await db.select(conversationFields).from(conversations).where(owned(conversations, ownerId, page.after)))[0]) : null;
  if (projectId) await getProject(ownerId, projectId, db);
  if (cursor && projectId !== undefined && cursor.projectId !== projectId) throw new ApiError(400, "Cursor does not match project filter");
  const rows = await db.select(conversationFields).from(conversations).where(and(eq(conversations.ownerId, ownerId),
    projectId === null ? isNull(conversations.projectId) : projectId ? eq(conversations.projectId, uuid(projectId)) : undefined,
    cursor ? sql`(${conversations.createdAt}, ${conversations.id}) > (SELECT created_at, id FROM conversation WHERE id = ${cursor.id})` : undefined)).orderBy(asc(conversations.createdAt), asc(conversations.id)).limit(page.limit + 1);
  return { conversations: rows.slice(0, page.limit), nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null };
}
export async function createConversation(ownerId: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ["title", "projectId"]);
  const projectId = body.projectId === undefined || body.projectId === null ? null : uuid(body.projectId);
  const name = body.title === undefined ? initialTitle() : title(body.title);
  return db.transaction(async tx => {
    if (projectId) await ownProject(tx, ownerId, projectId);
    return publicConversation((await tx.insert(conversations).values({ ownerId, projectId, title: name }).returning())[0]);
  });
}
export async function updateConversation(ownerId: string, id: string, input: unknown, db: Database = getDb()) {
  const body = fields(input, ["title", "projectId"]);
  if (!Object.keys(body).length) throw new ApiError(400, "Provide title or projectId");
  const patch = { ...(body.title !== undefined ? { title: title(body.title) } : {}),
    ...(Object.hasOwn(body, "projectId") ? { projectId: body.projectId === null ? null : uuid(body.projectId) } : {}), updatedAt: new Date() };
  return db.transaction(async tx => {
    if (patch.projectId) await ownProject(tx, ownerId, patch.projectId);
    await lockConversation(tx, ownerId, id);
    return publicConversation((await tx.update(conversations).set(patch).where(owned(conversations, ownerId, id)).returning())[0]);
  });
}
/** Internal cleanup receipt: never serialize provider IDs in the deletion response. */
export async function deleteConversation(ownerId: string, id: string, db: Database = getDb()) {
  return db.transaction(async tx => {
    const row = await lockConversation(tx, ownerId, id);
    const [active] = row.currentGenerationId ? await tx.select().from(messages).where(and(eq(messages.conversationId, row.id), eq(messages.generationId, row.currentGenerationId))).limit(1) : [];
    const runs = await tx.select({ id: messages.generationId }).from(messages).where(eq(messages.conversationId, row.id));
    const ids = runs.flatMap(run => run.id ? [run.id] : []);
    if (ids.length) await tx.update(generationJobs).set({ cleanup: true, updatedAt: new Date() }).where(inArray(generationJobs.id, ids));
    await tx.delete(conversations).where(owned(conversations, ownerId, id));
    return { generationId: row.currentGenerationId, providerResponseId: active?.providerResponseId ?? null, status: active?.status ?? null };
  });
}
export async function listMessages(ownerId: string, id: string, page: ReturnType<typeof pagination>, db: Database = getDb()) {
  return db.transaction(async tx => {
    const conversation = await lockConversation(tx, ownerId, id);
    const cursor = page.after ? found((await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.id, page.after))))[0]) : null;
    const rows = await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), cursor ? or(gt(messages.turn, cursor.turn), cursor.role === "user" ? and(eq(messages.turn, cursor.turn), eq(messages.role, "assistant")) : undefined) : undefined)).orderBy(asc(messages.turn), desc(messages.role)).limit(page.limit + 1);
    const [latest] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user"))).orderBy(desc(messages.turn)).limit(1);
    const [active] = conversation.currentGenerationId ? await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.generationId, conversation.currentGenerationId))).limit(1) : [];
    return { messages: rows.slice(0, page.limit).map(publicMessage), nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
      lastEditableUserMessageId: latest?.id ?? null, currentGeneration: active ? publicMessage(active) : null };
  });
}
