import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationProviders } from '../../components/conversation/conversation-providers'

test('shared conversation providers render a session gate without service credentials', () => {
  const html = renderToStaticMarkup(
    createElement(
      ConversationProviders,
      null,
      createElement('div', null, 'Private conversation contents'),
    ),
  )
  assert.match(html, /Loading your workspace/)
  assert.match(html, /Loading workspace/)
  assert.doesNotMatch(html, /Private conversation contents/)
})
