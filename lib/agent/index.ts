import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "../db";
import { conversations, generationEvents, generationJobs, messages, turnRequests, user } from "../db/schema";
import { effectivePreferences, validatePreferences } from "../models";
import { fields, initialTitle, lockConversation, publicMessage, uuid } from "../organization";
import { ApiError } from "../server/http";
import { releasePaid, reservePaid } from "../server/openai";

export type Message = typeof messages.$inferSelect;
export const active = (status: string) => status === "pending" || status === "running";
export function messageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !value.isWellFormed()) throw new ApiError(400, "Provide valid message text");
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) throw new ApiError(413, "Message exceeds 64 KiB");
  return value;
}
export async function addEvent(tx: Transaction, row: Message, type: string, data: Record<string, unknown>) {
  await tx.insert(generationEvents).values({ messageId: row.id, type, data: { messageId: row.id, generationId: row.generationId, ...data } });
}
export async function queueCleanup(generationId: string, tx: Database | Transaction = getDb()) {
  await tx.update(generationJobs).set({ cleanup: true, updatedAt: new Date() }).where(eq(generationJobs.id, generationId));
}
// All start/edit/retry paths reserve through this one transaction; no provider work in HTTP handlers.
export async function submitTurn(ownerId: string, conversationId: string, input: unknown,
  mode: { kind: "start" | "replace" | "retry"; targetId?: string } = { kind: "start" }, db: Database = getDb()) {
  const body = fields(input, mode.kind === "retry" ? ["requestId", "preferences"] : ["requestId", "text", "preferences"]);
  const requestId = uuid(body.requestId);
  const text = mode.kind === "retry" ? undefined : messageText(body.text);
  let override: ReturnType<typeof validatePreferences> | undefined;
  if (body.preferences !== undefined) {
    try { override = validatePreferences(body.preferences); } catch { throw new ApiError(400, "Unsupported model or reasoning effort"); }
  }
  const target = mode.targetId === undefined ? undefined : uuid(mode.targetId);
  const fingerprint = createHash("sha256").update(JSON.stringify({ kind: mode.kind, target, text, preferences: override })).digest("hex");
  return db.transaction(async tx => {
    const conversation = await lockConversation(tx, ownerId, conversationId);
    const [previousRequest] = await tx.select().from(turnRequests).where(and(eq(turnRequests.conversationId, conversation.id), eq(turnRequests.requestId, requestId)));
    if (previousRequest) {
      if (previousRequest.fingerprint !== fingerprint) throw new ApiError(409, "Request ID already used with different input");
      const [existing] = await tx.select().from(messages).where(eq(messages.generationId, previousRequest.generationId));
      if (!existing) throw new ApiError(409, "This request was discarded; use a new request ID");
      return { userMessageId: (await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.turn, existing.turn), eq(messages.role, "user"))))[0].id,
        generation: publicMessage(existing), deduplicated: true };
    }
    const [latestUser] = await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "user"))).orderBy(desc(messages.turn)).limit(1);
    const [latestAssistant] = latestUser ? await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.turn, latestUser.turn), eq(messages.role, "assistant"))) : [];
    if (latestAssistant && active(latestAssistant.status)) throw new ApiError(409, "Generation active; cancel or wait before changing the turn");
    if (mode.kind === "start" && latestAssistant && latestAssistant.status !== "completed") throw new ApiError(409, "Retry or replace the unfinished latest turn first");
    if (mode.kind !== "start" && (!latestUser || !latestAssistant || target !== (mode.kind === "replace" ? latestUser.id : latestAssistant.generationId))) throw new ApiError(409, "Only the latest user turn is mutable");
    if (mode.kind === "retry" && latestAssistant?.status !== "failed" && latestAssistant?.status !== "cancelled") throw new ApiError(409, "Only failed or cancelled turns can be retried");
    const [owner] = await tx.select().from(user).where(eq(user.id, ownerId));
    const preferences = override ?? effectivePreferences(owner);
    const generationId = randomUUID();
    await reservePaid(ownerId, generationId, "response", tx);
    const version = conversation.generationVersion + 1;
    const before = mode.kind === "start" ? conversation.context ?? [] : latestAssistant!.contextBefore ?? [];
    const responseBefore = mode.kind === "start" ? conversation.providerResponseId : latestAssistant!.responseIdBefore;
    let userMessage: Message;
    let turn: number;
    if (mode.kind === "start") {
      turn = conversation.nextTurn;
      [userMessage] = await tx.insert(messages).values({ conversationId: conversation.id, turn, role: "user", requestId, text: text! }).returning();
    } else {
      turn = latestUser!.turn;
      await queueCleanup(latestAssistant!.generationId!, tx);
      await tx.delete(messages).where(eq(messages.id, latestAssistant!.id));
      [userMessage] = await tx.update(messages).set({ ...(text !== undefined ? { text, requestId } : {}), updatedAt: new Date() }).where(eq(messages.id, latestUser!.id)).returning();
    }
    const [assistant] = await tx.insert(messages).values({ conversationId: conversation.id, turn, role: "assistant", requestId,
      generationId, generationVersion: version, status: "pending", ...preferences, contextBefore: before, responseIdBefore: responseBefore }).returning();
    await tx.insert(generationJobs).values({ id: generationId });
    await tx.insert(turnRequests).values({ conversationId: conversation.id, requestId, fingerprint, generationId });
    await tx.update(conversations).set({ currentGenerationId: generationId, generationVersion: version,
      nextTurn: mode.kind === "start" ? turn + 1 : conversation.nextTurn, context: before, providerResponseId: responseBefore,
      ...(conversation.nextTurn === 0 && conversation.title === "New conversation" ? { title: initialTitle(text) } : {}), updatedAt: new Date() }).where(eq(conversations.id, conversation.id));
    await addEvent(tx, assistant, "status", { status: "pending" });
    return { userMessageId: userMessage.id, generation: publicMessage(assistant), deduplicated: false };
  });
}
export async function getGeneration(ownerId: string, conversationId: string, generationId: string, db: Database = getDb()) {
  return db.transaction(async tx => {
    const conversation = await lockConversation(tx, ownerId, conversationId);
    const [row] = await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.generationId, uuid(generationId))));
    if (!row) throw new ApiError(404, "Generation not found");
    const [event] = await tx.select({ id: generationEvents.id }).from(generationEvents).where(eq(generationEvents.messageId, row.id)).orderBy(desc(generationEvents.id)).limit(1);
    return { ...publicMessage(row), error: row.error, eventCursor: event?.id ?? 0 };
  });
}
export async function readEvents(ownerId: string, conversationId: string, generationId: string, after: number, db: Database = getDb()) {
  const snapshot = await getGeneration(ownerId, conversationId, generationId, db);
  if (after !== 0) {
    const [cursor] = await db.select().from(generationEvents).where(and(eq(generationEvents.messageId, snapshot.id), eq(generationEvents.id, after)));
    if (!cursor) throw new ApiError(409, "Cursor does not belong to this generation; reload its snapshot");
  }
  const events = await db.select().from(generationEvents).where(and(eq(generationEvents.messageId, snapshot.id), gt(generationEvents.id, after))).orderBy(asc(generationEvents.id)).limit(100);
  return { snapshot, events };
}
export async function cancelGeneration(ownerId: string, conversationId: string, generationId: string, db: Database = getDb()) {
  return db.transaction(async tx => {
    const conversation = await lockConversation(tx, ownerId, conversationId);
    const [row] = await tx.select().from(messages).where(and(eq(messages.conversationId, conversation.id), eq(messages.generationId, uuid(generationId))));
    if (!row) throw new ApiError(404, "Generation not found");
    if (active(row.status)) {
      await tx.update(messages).set({ status: "cancelled", error: "cancelled", updatedAt: new Date() }).where(eq(messages.id, row.id));
      await queueCleanup(row.generationId!, tx);
      await releasePaid(row.generationId!, tx);
      await addEvent(tx, row, "error", { status: "cancelled", code: "cancelled" });
    }
    return { generationId: row.generationId, status: active(row.status) ? "cancelled" : row.status };
  });
}

/** Consume Organization's internal receipt; remote work stays outside the deletion transaction. */
export async function deletionCleanup(receipt: { generationId: string | null; providerResponseId: string | null }, db: Database = getDb()) {
  if (!receipt.generationId) return;
  await db.insert(generationJobs).values({ id: receipt.generationId, providerResponseId: receipt.providerResponseId,
    state: receipt.providerResponseId ? "monitoring" : "done", cleanup: true })
    .onConflictDoUpdate({ target: generationJobs.id, set: { cleanup: true } });
}
