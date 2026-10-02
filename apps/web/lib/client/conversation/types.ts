import type { Effort, Model, Preferences } from '@agent/backend/models'
export type { Effort, Model, Preferences }
export type GenerationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type Citation = {
  type: 'url_citation'
  url: string
  title: string
  start_index?: number
  end_index?: number
}
export type Conversation = {
  id: string
  projectId: string | null
  title: string
  createdAt: string
  updatedAt: string
}
export type Message = {
  id: string
  turn: number
  role: 'user' | 'assistant'
  text: string
  status: GenerationStatus
  model: Model | null
  effort: Effort | null
  generationId: string | null
  streamCursor: number
  citations: Citation[]
  createdAt: string
  updatedAt: string
}
export type Generation = Message & { error: string | null; eventCursor: number }
export type Profile = {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
  image: string | null
  preferences: Preferences
  spaceId: string
}
export type Catalog = { id: Model; name: string; efforts: Effort[] }[]
export type Admission = { userMessageId: string; generation: Message; deduplicated: boolean }
export type Submission = { conversationId: string; userMessageId: string; generationId: string }
export type ClientError = { status: number | null; message: string }
export type ConversationState = {
  sessionStatus: 'loading' | 'authenticated' | 'anonymous' | 'error'
  profile: Profile | null
  catalog: Catalog
  preferences: Preferences | null
  conversations: Conversation[]
  listLoading: boolean
  listError: ClientError | null
  conversationId: string | null
  conversation: Conversation | null
  messages: Message[]
  historyLoading: boolean
  historyError: ClientError | null
  lastEditableUserMessageId: string | null
  generation: Generation | null
  transportError: ClientError | null
  draft: string
  admissionPending: boolean
  preferencePending: boolean
  cancelPending: boolean
  actionError: ClientError | null
  submission: Submission | null
  initialize: () => Promise<void>
  signIn: () => Promise<void>
  logout: () => Promise<void>
  expireSession: () => void
  selectConversation: (id: string | null) => Promise<void>
  refreshConversations: () => Promise<void>
  setDraft: (text: string) => void
  setEffort: (effort: Effort) => Promise<void>
  submit: (text?: string) => Promise<Submission | null>
  replaceMessage: (messageId: string, text: string) => Promise<Submission | null>
  retryGeneration: () => Promise<Submission | null>
  cancelResponse: () => Promise<void>
  transcribeRecording: (audio: Blob, filename: string, signal?: AbortSignal) => Promise<string>
  clearActionError: () => void
  dispose: () => void
}
export const isActiveGeneration = (generation: Message | null) =>
  generation?.status === 'pending' || generation?.status === 'running'
export const selectCanEdit = (state: ConversationState) =>
  !!state.lastEditableUserMessageId &&
  !state.historyLoading &&
  !state.historyError &&
  !state.admissionPending &&
  !state.cancelPending &&
  !isActiveGeneration(state.generation)
export const selectNeedsRecovery = (state: ConversationState) =>
  state.generation?.status === 'failed' || state.generation?.status === 'cancelled'
export const selectCanSubmit = (state: ConversationState) =>
  state.sessionStatus === 'authenticated' &&
  !!state.preferences &&
  !state.historyLoading &&
  !state.historyError &&
  !state.admissionPending &&
  !state.preferencePending &&
  !state.cancelPending &&
  !isActiveGeneration(state.generation) &&
  !selectNeedsRecovery(state)
