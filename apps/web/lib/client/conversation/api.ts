import type { ClientError } from './types'

export class ConversationApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export function clientError(error: unknown): ClientError {
  if (error instanceof ConversationApiError) return { status: error.status, message: error.message }
  return { status: null, message: 'Connection failed. Try again.' }
}
export function validateMessageText(text: string) {
  if (!text.trim() || text.includes('\0') || !text.isWellFormed())
    throw new ConversationApiError(400, 'Enter valid, nonblank message text.')
  if (new TextEncoder().encode(text).length > 64 * 1024)
    throw new ConversationApiError(413, 'Message exceeds 64 KiB.')
  return text
}
export function createConversationApi(fetcher: typeof fetch = fetch) {
  async function response(path: string, init: RequestInit = {}) {
    const result = await fetcher(path, { credentials: 'include', cache: 'no-store', ...init })
    if (!result.ok) {
      const body = await result.json().catch(() => null)
      const message =
        result.status === 401
          ? 'Your session expired. Sign in again.'
          : result.status === 404
            ? 'Requested resource is unavailable.'
            : result.status === 429
              ? 'Request limit reached. Wait and try again.'
              : result.status >= 500
                ? 'Service is unavailable. Try again.'
                : typeof body?.error === 'string'
                  ? body.error
                  : 'Request failed. Try again.'
      throw new ConversationApiError(result.status, message)
    }
    return result
  }
  async function json<T>(
    path: string,
    signal: AbortSignal,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    return (
      await response(path, {
        signal,
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
    ).json()
  }
  async function events(path: string, signal: AbortSignal, receive: (event: StreamEvent) => void) {
    const result = await response(path, { signal, headers: { Accept: 'text/event-stream' } })
    if (!result.body) throw new Error('Stream is unavailable')
    const reader = result.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          let type = 'message'
          let id: number | undefined
          const data: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim()
            if (line.startsWith('id:')) {
              const raw = line.slice(3).trim()
              if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) id = Number(raw)
            }
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (data.length) receive({ type, id, data: JSON.parse(data.join('\n')) })
        }
        if (done) return
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  async function upload<T>(path: string, signal: AbortSignal, body: FormData): Promise<T> {
    return (await response(path, { signal, method: 'POST', body })).json()
  }
  return { json, events, upload }
}
export type StreamEvent = { type: string; id?: number; data: Record<string, unknown> }
