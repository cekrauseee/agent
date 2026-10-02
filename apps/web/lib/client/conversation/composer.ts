export type RecordingDraft = {
  text: string
  selectionStart: number | null
  selectionEnd: number | null
}

export function insertTranscript(draft: RecordingDraft, transcript: string): string {
  if (!transcript.trim()) return draft.text
  const start = Math.max(0, Math.min(draft.selectionStart ?? draft.text.length, draft.text.length))
  const end = Math.max(start, Math.min(draft.selectionEnd ?? start, draft.text.length))
  return draft.text.slice(0, start) + transcript + draft.text.slice(end)
}

export function messageValidation(text: string): string | null {
  if (!text.trim()) return 'Write a message before sending.'
  if (new TextEncoder().encode(text).byteLength > 65_536)
    return 'Message is too long. Use at most 65,536 UTF-8 bytes.'
  return null
}

export function isSubmitKey(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing
}
