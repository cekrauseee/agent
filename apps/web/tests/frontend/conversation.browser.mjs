// Run against a local app with the browser-only transport installed before navigation.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const url = process.env.CONVERSATION_QA_URL || 'http://localhost:3100'
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
  'QA requires a local app',
)
const session = process.env.CONVERSATION_QA_SESSION || 'conversation-integration-qa'
const browser = (...args) => {
  const output = execFileSync(
    'pnpm',
    ['dlx', 'agent-browser@0.38.1', '--session', session, '--json', ...args],
    { encoding: 'utf8' },
  )
  const result = JSON.parse(output)
  assert.equal(result.success, true, result.error)
  return result.data
}
const evaluate = (code) => browser('eval', code).result
const wait = (condition) => browser('wait', '--fn', condition)
let checks = 0
const check = (condition, label) => {
  assert.equal(evaluate(condition), true, label)
  checks++
}
const click = (name) => browser('find', 'role', 'button', 'click', '--name', name, '--exact')
const fill = (text) => browser('fill', 'textarea[name=message]', text)
const fixture = 'window.__conversationFixture'
const generation = () => evaluate(`${fixture}.latestGeneration()`)
const complete = (id, text) => {
  evaluate(`${fixture}.complete(${JSON.stringify(id)}, ${JSON.stringify(text)})`)
  wait(
    `document.querySelector('[data-generation-id="${id}"][data-status=completed]')?.textContent.includes(${JSON.stringify(text.split('\n')[0])})`,
  )
}
const sends = () =>
  evaluate(
    `${fixture}.requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages')).length`,
  )
const geometry = () =>
  evaluate(`(() => {
  const view = document.querySelector('[data-slot=message-scroller-viewport]')
  const items = Array.from(document.querySelectorAll('[data-slot=message-scroller-item][data-message-id]'))
  return { top: view.scrollTop, inset: items.at(-2).getBoundingClientRect().top - view.getBoundingClientRect().top,
    space: document.querySelector('[data-turn-spacer]').getBoundingClientRect().height }
})()`)

browser('close')
browser('--init-script', resolve('tests/frontend/browser-fixture.mjs'), 'open', url)
evaluate(`${fixture}.reset()`)
wait('!!document.querySelector("textarea[name=message]")')
browser('set', 'viewport', '1024', '768')
check(
  'document.querySelector("h1").textContent.includes("talk about")',
  'Authenticated Home renders',
)
check(
  'document.querySelector("[aria-label=\\"Send message\\"]").disabled',
  'Blank message cannot send',
)
browser('find', 'role', 'combobox', 'click', '--name', 'Reasoning effort')
browser('find', 'role', 'option', 'click', '--name', 'high', '--exact')
fill('First integrated question')
click('Send message')
wait(
  'location.pathname.startsWith("/conversation/") && !!document.querySelector("[data-status=pending]")',
)
const conversationPath = evaluate('location.pathname')
const firstUserId = evaluate(`${fixture}.state.conversations.at(-1).messages[0].id`)
let id = generation()
check(
  `${fixture}.state.conversations.length === 2`,
  'Home creates exactly one durable conversation',
)
check(
  `${fixture}.requests.some(r => r.method === 'POST' && r.path.endsWith('/messages') && JSON.parse(r.body).preferences.effort === 'high' && JSON.parse(r.body).preferences.model === 'gpt-6-luna')`,
  'Saved model and chosen effort reach admission',
)
check(
  'document.querySelector("[aria-label=\\"Conversations\\"]").textContent.includes("First integrated question")',
  'First-message title refreshes',
)
assert.ok(Math.abs(geometry().inset - 16) < 2, 'First short turn anchors at the inset')
checks++
check(
  'Array.from(document.querySelectorAll("button")).find(b=>b.textContent === "Edit").disabled',
  'Active response disables editing',
)
evaluate(`${fixture}.delta(${JSON.stringify(id)}, 'Partial response')`)
wait('document.body.innerText.includes("Generating response")')
fill('Draft preserved through cancellation')
click('Cancel response')
wait('document.body.innerText.includes("Response cancelled")')
check(
  'document.querySelector("textarea[name=message]").value === "Draft preserved through cancellation"',
  'Cancel response keeps draft and never submits it',
)
assert.equal(sends(), 1)
checks++
click('Retry response')
wait('!!document.querySelector("[data-status=pending]")')
id = generation()
check(
  `${fixture}.state.conversations.at(-1).messages[0].id === ${JSON.stringify(firstUserId)}`,
  'Retry preserves user identity',
)
evaluate(`${fixture}.delta(${JSON.stringify(id)}, 'Interrupted')`)
const eventConnections = evaluate(
  `${fixture}.requests.filter(r=>r.path.endsWith('/events')).length`,
)
evaluate(`${fixture}.disconnect(${JSON.stringify(id)})`)
wait(`${fixture}.requests.filter(r=>r.path.endsWith('/events')).length > ${eventConnections}`)
evaluate(`${fixture}.delta(${JSON.stringify(id)}, ' continued')`)
wait('document.body.innerText.includes("Interrupted continued")')
assert.equal(sends(), 1)
checks++
complete(id, 'Canonical first response')
check(
  '!document.body.innerText.includes("Interrupted continued")',
  'Canonical output replaces streamed partial text',
)
click('Edit')
browser('find', 'label', 'Edit message', 'fill', 'Rejected edit remains in editor')
evaluate(`${fixture}.failNext('/messages/',409,'Simulated replacement rejection')`)
click('Resubmit')
wait('document.body.innerText.includes("Simulated replacement rejection")')
check(
  'Array.from(document.querySelectorAll("textarea")).some(e=>e.value === "Rejected edit remains in editor")',
  'Rejected replacement retains edit buffer',
)
check(
  'document.body.innerText.includes("Canonical first response")',
  'Rejected replacement retains prior history',
)
click('Resubmit')
wait(
  '!!document.querySelector("[data-status=pending]") && !document.body.innerText.includes("Canonical first response")',
)
const replacementId = generation()
assert.notEqual(replacementId, id)
checks++
check(
  `${fixture}.state.conversations.at(-1).messages[0].id === ${JSON.stringify(firstUserId)}`,
  'Replacement preserves user ID and changes generation',
)
assert.ok(Math.abs(geometry().inset - 16) < 2, 'Replacement reanchors the same user ID')
checks++
complete(replacementId, 'Replaced canonical response')

for (const text of ['Second short question', 'Third short question']) {
  fill(text)
  click('Send message')
  wait('!!document.querySelector("[data-status=pending]")')
  assert.ok(Math.abs(geometry().inset - 16) < 2, `${text} anchors despite short history`)
  checks++
  complete(generation(), `${text} answer`)
}
fill('Long streamed question')
click('Send message')
wait('!!document.querySelector("[data-status=pending]")')
id = generation()
const anchoredTop = geometry().top
evaluate(`${fixture}.delta(${JSON.stringify(id)}, 'Long streamed line.\\n'.repeat(100))`)
wait('document.querySelector("[data-turn-spacer]").getBoundingClientRect().height === 0')
assert.ok(Math.abs(geometry().top - anchoredTop) < 2, 'Growing output keeps reader position')
checks++
const stationaryTop = geometry().top
evaluate(`${fixture}.delta(${JSON.stringify(id)}, 'Later streamed line.\\n'.repeat(20))`)
browser('wait', '100')
assert.ok(Math.abs(geometry().top - stationaryTop) < 2, 'Exhausted spacer never follows output')
checks++
complete(id, 'Long final line.\n'.repeat(100))
click('Edit')
browser('find', 'label', 'Edit message', 'fill', 'Replace a long response')
click('Resubmit')
wait('!!document.querySelector("[data-status=pending]")')
assert.ok(
  geometry().space > 0 && Math.abs(geometry().inset - 16) < 2,
  'Long-response replacement waits for canonical rows before reserving a fresh spacer',
)
checks++
complete(generation(), 'Short replacement response')
browser('reload')
wait('!!document.querySelector("[data-status=completed]")')
check(
  'document.querySelector("[data-turn-spacer]").getBoundingClientRect().height === 0',
  'Reload does not fabricate submission space',
)
check(
  `location.pathname === ${JSON.stringify(conversationPath)}`,
  'Reload keeps durable conversation route',
)

browser('find', 'role', 'link', 'click', '--name', 'New Conversation', '--exact')
wait('location.pathname === "/" && !!document.querySelector("textarea[name=message]")')
fill('Typed before recording. ')
const beforeVoice = sends()
click('Record a message')
wait('document.body.innerText.includes("Recording…")')
click('Cancel recording')
wait('!!document.querySelector("textarea[name=message]")')
check(
  'document.querySelector("textarea[name=message]").value === "Typed before recording. "',
  'Voice cancel preserves draft',
)
check(
  `${fixture}.requests.every(r=>r.path !== '/api/transcriptions')`,
  'Voice cancel never uploads',
)
evaluate(`${fixture}.transcribe('Inserted speech.')`)
click('Record a message')
wait('document.body.innerText.includes("Recording…")')
browser('wait', '300')
click('Stop and transcribe')
wait('!!document.querySelector("textarea[name=message]")')
check(
  'document.querySelector("textarea[name=message]").value.includes("Inserted speech.")',
  'Stop inserts transcript',
)
assert.equal(sends(), beforeVoice)
checks++
evaluate(`${fixture}.transcribe('')`)
const stoppedDraft = evaluate('document.querySelector("textarea[name=message]").value')
click('Record a message')
wait('document.body.innerText.includes("Recording…")')
browser('wait', '300')
click('Transcribe and send message')
wait('!!document.querySelector("textarea[name=message]")')
check(
  `document.querySelector('textarea[name=message]').value === ${JSON.stringify(stoppedDraft)}`,
  'Empty transcript preserves combined draft',
)
assert.equal(sends(), beforeVoice)
checks++
evaluate(`${fixture}.transcribe('Sent speech.')`)
click('Record a message')
wait('document.body.innerText.includes("Recording…")')
browser('wait', '300')
click('Transcribe and send message')
wait(
  'location.pathname.startsWith("/conversation/") && !!document.querySelector("[data-status=pending]")',
)
assert.equal(sends(), beforeVoice + 1)
checks++
check(
  `${fixture}.state.conversations.at(-1).messages[0].text.includes('Sent speech.')`,
  'Voice send uses shared combined-text submission',
)
complete(generation(), 'Voice response')
fill('Recover this draft before sign-in')
evaluate(`${fixture}.failNext('/api/me/preferences',401,'Expired fixture session')`)
browser('find', 'role', 'combobox', 'click', '--name', 'Reasoning effort')
browser('find', 'role', 'option', 'click', '--name', 'low', '--exact')
wait('document.body.innerText.includes("Your session expired")')
check(
  'document.querySelector("textarea").readOnly && document.querySelector("textarea").value === "Recover this draft before sign-in"',
  'Session expiry exposes recoverable draft',
)
check(
  'document.body.innerText.includes("Copy this draft before signing in")',
  'Redirect/reload draft loss is explicit',
)
check(
  '!document.querySelector("[aria-label=\\"Account menu\\"]")',
  'Session expiry clears private shell',
)
assert.deepEqual(browser('errors').errors ?? [], [])
console.log(
  `Conversation browser checks passed: ${checks} assertions across admission, SSE, editing, geometry, voice and session expiry.`,
)
