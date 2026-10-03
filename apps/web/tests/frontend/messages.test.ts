import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ConversationMessage,
  ConversationMessageContent,
  ConversationMessages,
  InlineMessageEditor,
  safeMessageUrl,
} from '../../components/conversation/conversation-messages'
import type { Message } from '../../lib/client/conversation/types'

const user: Message = {
  id: 'user-latest',
  turn: 1,
  role: 'user',
  text: '  Original\n\ntext  ',
  status: 'completed',
  model: null,
  effort: null,
  generationId: null,
  streamCursor: -1,
  citations: [],
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
}
const noop = async () => null
const row = (message: Message, canEdit = true, latest = user.id, canRetry = false) =>
  renderToStaticMarkup(
    createElement(ConversationMessage, {
      message,
      lastEditableUserMessageId: latest,
      canEdit,
      canRetry,
      admissionPending: false,
      error: null,
      onReplace: noop,
      onRetry: noop,
    }),
  )

test('only the server-designated latest user exposes Edit and active work blocks it', () => {
  assert.doesNotMatch(row({ ...user, id: 'user-older' }), />Edit</)
  assert.match(row(user), />Edit</)
  assert.match(row(user, false), /disabled=""[^>]*>Edit</)
})

test('content preserves user whitespace, renders Markdown and rejects unsafe links and HTML', () => {
  const plain = renderToStaticMarkup(createElement(ConversationMessageContent, { message: user }))
  assert.match(plain, /  Original\n\ntext  /)
  const markdown = renderToStaticMarkup(
    createElement(ConversationMessageContent, {
      message: {
        ...user,
        role: 'assistant',
        text: '**Strong**\n\n- item\n\n[Good](https://example.com) [Bad](javascript:alert%281%29)\n\n<script>alert(1)</script>',
        citations: [
          { type: 'url_citation', url: 'https://example.com/source', title: 'Actual source' },
          {
            type: 'url_citation',
            url: 'https://user:secret@example.com/source',
            title: 'Unsafe source',
          },
        ],
      },
    }),
  )
  assert.match(markdown, /<strong>Strong<\/strong>/)
  assert.match(markdown, /<li>item<\/li>/)
  assert.match(markdown, /href="https:\/\/example.com\/"/)
  assert.match(markdown, /Actual source/)
  assert.doesNotMatch(markdown, /<script|javascript:|Unsafe source|user:secret/)
  for (const url of [
    'data:text/html,hi',
    'javascript:alert(1)',
    '//evil.com',
    '/relative',
    'file:///x',
  ]) {
    assert.equal(safeMessageUrl(url), undefined)
  }
})

test('queued, running, failed and cancelled responses stay visibly distinct', () => {
  const assistant = {
    ...user,
    id: 'assistant',
    role: 'assistant' as const,
    generationId: 'generation',
  }
  assert.match(row({ ...assistant, text: '', status: 'pending' }), /Response queued/)
  assert.match(row({ ...assistant, status: 'running' }), /Generating response/)
  assert.match(row({ ...assistant, status: 'failed' }, true, user.id, true), /Response incomplete/)
  assert.match(row({ ...assistant, status: 'failed' }, true, user.id, true), /Retry response/)
  assert.match(row({ ...assistant, status: 'cancelled' }), /Response cancelled/)
  assert.doesNotMatch(
    row({ ...assistant, status: 'completed' }),
    /Retry response|Generating response/,
  )
})

test('a concurrent latest-user change explains the conflict and retains the original editor buffer', () => {
  const html = renderToStaticMarkup(
    createElement(InlineMessageEditor, {
      message: user,
      isLatest: false,
      canEdit: false,
      admissionPending: false,
      error: null,
      onReplace: noop,
      onClose: () => {},
    }),
  )
  assert.match(html, /Only the latest message can be edited/)
  assert.match(html, /  Original\n\ntext  /)
  assert.match(html, /disabled=""[^>]*>Resubmit</)
  assert.match(html, /for="[^"]+"/)
  assert.match(html, /aria-describedby=/)
})

test('canonical generation output replaces stale rendered deltas in the same backend row', () => {
  const saved = {
    ...user,
    id: 'assistant',
    role: 'assistant' as const,
    generationId: 'current-generation',
    status: 'running' as const,
    text: 'Stale delta text',
  }
  const html = renderToStaticMarkup(
    createElement(ConversationMessages, {
      conversationId: 'conversation',
      messages: [user, saved],
      generation: {
        ...saved,
        status: 'completed',
        text: 'Canonical final text',
        eventCursor: 2,
        error: null,
      },
      submission: null,
      lastEditableUserMessageId: user.id,
      canEdit: true,
      admissionPending: false,
      cancelPending: false,
      historyLoading: false,
      historyError: null,
      transportError: null,
      actionError: null,
      onReplace: noop,
      onRetry: noop,
    }),
  )
  assert.match(html, /Canonical final text/)
  assert.doesNotMatch(html, /Stale delta text|Generating response/)
  assert.equal((html.match(/data-slot="message"/g) ?? []).length, 2)
})
