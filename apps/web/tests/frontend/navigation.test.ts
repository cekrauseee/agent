import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  HomeShell,
  profileDisplayName,
  type HomeNavigationState,
} from '../../components/conversation/home-shell'
import { TooltipProvider } from '../../components/ui/tooltip'

const profile = {
  id: 'user',
  firstName: ' Alex ',
  lastName: ' Doe ',
  email: 'alex@example.test',
  image: null,
  preferences: { model: 'gpt-6-luna', effort: 'medium' },
  spaceId: 'space',
} as const
const navigation: HomeNavigationState = {
  profile,
  conversations: ['oldest', 'newest'].map((id) => ({
    id,
    title: id,
    projectId: null,
    createdAt: '',
    updatedAt: '',
  })),
  listLoading: false,
  listError: null,
  refreshConversations: async () => {},
  logout: async () => {},
  startNewConversation: () => {},
}
const render = (state = navigation) => {
  const props = { navigation: state, conversationId: 'newest', children: 'Main content' }
  return renderToString(createElement(TooltipProvider, null, createElement(HomeShell, props)))
}

test('route selection and backend order survive rendering without browser globals', () => {
  const html = render()
  assert.match(html, /href="\/conversation\/oldest"/)
  const selectedLink = html.match(/<a[^>]*href="\/conversation\/newest"[^>]*>/)?.[0] ?? ''
  assert.match(selectedLink, /aria-current="page"/)
  assert.ok(
    html.indexOf('href="/conversation/oldest"') < html.indexOf('href="/conversation/newest"'),
  )
  assert.match(html, /href="\/"[^>]*>.*New Conversation/)
  assert.match(html, /aria-label="Account menu"/)
  assert.equal((html.match(/<main/g) ?? []).length, 1)
  assert.match(html, /Skip to content/)
})

test('account name uses profile fields, then email without placeholder identity', () => {
  assert.equal(profileDisplayName(profile), 'Alex Doe')
  assert.equal(profileDisplayName({ ...profile, firstName: ' ', lastName: null }), profile.email)
  assert.equal(profileDisplayName({ ...profile, firstName: null }), 'Doe')
})

test('loading, empty and failed history remain explicit and recoverable', () => {
  assert.match(render({ ...navigation, listLoading: true }), /aria-busy="true"/)
  assert.match(render({ ...navigation, conversations: [] }), /No conversations yet/)
  const failed = render({
    ...navigation,
    conversations: [],
    listError: { status: 503, message: 'Try later.' },
  })
  assert.match(failed, /Conversations unavailable/)
  assert.match(failed, /Try again/)
  assert.doesNotMatch(failed, /No conversations yet/)
})
