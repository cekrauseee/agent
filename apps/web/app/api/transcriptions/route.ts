import { requireOwner } from '@agent/backend/auth'
import { api, ApiError, json } from '@agent/backend/server/http'
import { getOpenAI, withPaidRequest } from '@agent/backend/server/openai'
import { readAudio, transcribe } from '@agent/backend/transcription'

export const runtime = 'nodejs'

export function POST(request: Request) {
  return api(async () => {
    const ownerId = await requireOwner(request)
    const file = await readAudio(request)
    let client
    try {
      client = getOpenAI()
    } catch {
      throw new ApiError(503, 'Transcription service unavailable')
    }
    return json(
      await withPaidRequest(ownerId, 'transcription', () =>
        transcribe(file, client, request.signal),
      ),
    )
  })
}
