import assert from 'node:assert/strict'
import test from 'node:test'
import { messageText } from '@agent/backend/agent'
import { eventCursor } from '@agent/backend/agent/stream'

test('generation message and event cursor bounds', () => {
  for (const text of ['', ' ', null, '\0', '\ud800', 'x'.repeat(65_537)])
    assert.throws(() => messageText(text))
  assert.equal(messageText('  original language\n'), '  original language\n')
  for (const cursor of ['-1', '1.5', 'bad', '2147483648'])
    assert.throws(() => eventCursor(new Request(`http://localhost/events?after=${cursor}`)))
})
