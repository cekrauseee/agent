import 'server-only'
import { setTimeout } from 'node:timers/promises'
import { getGeneration, readEvents, active } from './index'
import { ApiError } from '../server/http'

export function eventCursor(request: Request) {
  const raw = new URL(request.url).searchParams.get('after') ?? request.headers.get('last-event-id')
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647)
    throw new ApiError(400, 'Invalid event cursor')
  return Number(raw)
}
export async function eventStream(
  request: Request,
  ownerId: string,
  conversationId: string,
  generationId: string,
) {
  let cursor = eventCursor(request)
  const snapshot = await getGeneration(ownerId, conversationId, generationId)
  if (cursor !== undefined) await readEvents(ownerId, conversationId, generationId, cursor)
  let stopped = false
  let first = true
  const end = Date.now() + 30_000
  const encoder = new TextEncoder()
  const frame = (type: string, data: unknown, id?: number) =>
    encoder.encode(
      `${id === undefined ? '' : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
    )
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (stopped || request.signal.aborted) {
          controller.close()
          return
        }
        if (first) {
          first = false
          if (cursor === undefined) {
            cursor = snapshot.eventCursor
            controller.enqueue(frame('snapshot', snapshot, cursor))
            if (!active(snapshot.status)) controller.close()
            return
          }
        }
        while (!stopped && !request.signal.aborted && Date.now() < end) {
          const { snapshot: current, events } = await readEvents(
            ownerId,
            conversationId,
            generationId,
            cursor!,
          )
          if (stopped) return
          if (events.length) {
            for (const event of events) {
              controller.enqueue(frame(event.type, event.data, event.id))
              cursor = event.id
            }
            return
          }
          if (!active(current.status)) {
            controller.close()
            return
          }
          await setTimeout(250)
        }
        if (!stopped) controller.close()
      } catch {
        if (!stopped) {
          controller.enqueue(frame('error', { code: 'stream_unavailable', generationId }))
          controller.close()
        }
      }
    },
    cancel() {
      stopped = true
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
