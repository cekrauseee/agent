import assert from 'node:assert/strict'
import test from 'node:test'
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
