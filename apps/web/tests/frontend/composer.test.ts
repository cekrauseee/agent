import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TextComposer, type TextComposerProps } from '../../components/conversation/text-composer'
import {
  insertTranscript,
  isSubmitKey,
  messageValidation,
} from '../../lib/client/conversation/composer'

test('the composer admits only nonblank messages within the backend UTF-8 limit', () => {
  assert.equal(messageValidation(' \n\t'), 'Write a message before sending.')
  assert.equal(messageValidation('é'.repeat(32_768)), null)
  assert.match(messageValidation('é'.repeat(32_769))!, /too long/)
  assert.equal(messageValidation('hello\nworld'), null)
})

test('Enter submits while Shift+Enter and IME composition leave the textarea alone', () => {
  assert.equal(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false }), true)
  assert.equal(isSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false }), false)
  assert.equal(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true }), false)
  assert.equal(isSubmitKey({ key: 'a', shiftKey: false, isComposing: false }), false)
})

test('transcription uses the recorded selection and leaves the draft intact on empty output', () => {
  const draft = { text: 'hello world', selectionStart: 6, selectionEnd: 11 }
  assert.equal(insertTranscript(draft, 'there'), 'hello there')
  assert.equal(insertTranscript(draft, ' \n'), draft.text)
  assert.equal(insertTranscript({ ...draft, selectionEnd: 6 }, 'new '), 'hello new world')
  assert.equal(
    insertTranscript({ ...draft, selectionStart: null, selectionEnd: null }, '!'),
    'hello world!',
  )
  assert.equal(insertTranscript({ ...draft, selectionStart: -1, selectionEnd: 99 }, 'new'), 'new')
})

const props: TextComposerProps = {
  value: 'next draft',
  onValueChange: () => {},
  preferences: { model: 'gpt-6-luna', effort: 'medium' },
  catalog: [{ id: 'gpt-6-luna', name: 'Luna', efforts: ['low', 'medium'] }],
  onEffortChange: async () => {},
  canSubmit: true,
  admissionPending: false,
  preferencePending: false,
  generationActive: false,
  cancelPending: false,
  needsRecovery: false,
  onSubmit: async () => null,
  onCancelResponse: async () => {},
}

test('active response has an explicit non-submit cancellation and preserves an editable draft', () => {
  const html = renderToStaticMarkup(
    createElement(TextComposer, { ...props, canSubmit: false, generationActive: true }),
  )
  assert.match(html, /<textarea[^>]*>next draft<\/textarea>/)
  assert.match(html, /type="button"[^>]*>.*Cancel response/)
  assert.doesNotMatch(html, /aria-label="Send message"/)
  assert.doesNotMatch(html, /<textarea[^>]* disabled=""/)
})

test('recovery blocks sending and the recording slot replaces the only text form', () => {
  const recovery = renderToStaticMarkup(
    createElement(TextComposer, { ...props, canSubmit: false, needsRecovery: true }),
  )
  assert.match(recovery, /aria-label="Send message"[^>]*disabled/)
  assert.match(recovery, /Retry the last response or edit the last message/)
  const recording = renderToStaticMarkup(
    createElement(TextComposer, { ...props, recording: createElement('span', null, 'Recording') }),
  )
  assert.match(recording, /Recording/)
  assert.doesNotMatch(recording, /<textarea|aria-label="Send message"/)
})
