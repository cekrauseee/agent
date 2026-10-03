// Run against a local app with an authenticated QA fixture already installed in the browser session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const url = process.env.NAVIGATION_QA_URL
assert.ok(url, 'Set NAVIGATION_QA_URL to the local fixture app URL')
const session = process.env.NAVIGATION_QA_SESSION || 'navigation-qa'
const browser = (...args) => {
  const output = execFileSync(
    'pnpm',
    ['dlx', 'agent-browser', '--session', session, '--json', ...args],
    {
      encoding: 'utf8',
    },
  )
  const result = JSON.parse(output)
  assert.equal(result.success, true, result.error)
  return result.data
}
const evaluate = (code) => browser('eval', code).result
const settle = () => browser('wait', '250')
const mainX = () => evaluate('document.querySelector("main").getBoundingClientRect().x')
const previewVisible = () =>
  evaluate('!!document.querySelector("[data-slot=popover-content][data-open]")')
const close = () => browser('click', '[aria-label="Close sidebar"]')
const home = '[aria-label="Home"]'

browser('set', 'viewport', '1280', '800')
browser('open', url)
browser('wait', '[aria-label="Close sidebar"]')
browser('wait', 'nav[aria-label=Conversations] a')
const dockedX = mainX()
close()
settle()
const collapsedX = mainX()
assert.ok(dockedX > collapsedX, 'Collapsing returns sidebar width to the main panel')
browser('focus', 'main')
browser('hover', home)
settle()
assert.equal(previewVisible(), true, 'Hover opens the preview')
assert.equal(evaluate('location.pathname'), new URL(url).pathname, 'Hover never navigates')
assert.equal(mainX(), collapsedX, 'Preview must not reserve main-panel width')
const panel = evaluate(
  'document.querySelector("[data-slot=popover-content]").getBoundingClientRect().toJSON()',
)
const trigger = evaluate(
  'document.querySelector("[aria-label=Home]").getBoundingClientRect().toJSON()',
)
browser('mouse', 'move', String(trigger.right + 3), String(trigger.y + 20))
browser('mouse', 'move', String(panel.x + 20), String(panel.y + 40))
settle()
assert.equal(previewVisible(), true, 'Crossing from Home into the panel keeps it open')
browser('mouse', 'move', '1100', '600')
settle()
assert.equal(previewVisible(), false, 'Leaving both areas closes the preview')

browser('focus', home)
browser('press', 'Enter')
settle()
assert.equal(previewVisible(), true, 'Keyboard activation opens the preview')
browser('press', 'Control+b')
settle()
assert.equal(mainX(), dockedX, 'Sidebar shortcut docks the preview')
browser('press', 'Control+b')
settle()
assert.equal(previewVisible(), false, 'Collapsing again does not restore an old preview')
browser('focus', home)
browser('press', 'Enter')
browser('focus', '[data-slot=popover-content] a')
browser('mouse', 'move', '1100', '600')
settle()
assert.equal(previewVisible(), true, 'Focus inside keeps the preview available')
browser('press', 'Escape')
settle()
assert.equal(previewVisible(), false)
assert.equal(evaluate('document.activeElement.getAttribute("aria-label")'), 'Home')
browser('press', 'Enter')
browser('click', '[aria-label="Pin sidebar"]')
settle()
assert.equal(mainX(), dockedX, 'Pinning restores the docked panel')

const conversationHref = evaluate(
  'document.querySelector("nav[aria-label=Conversations] a").getAttribute("href")',
)
browser('click', `a[href="${conversationHref}"]`)
browser('wait', '--url', `**${conversationHref}`)
assert.equal(
  evaluate('document.querySelector("a[aria-current=page]")?.getAttribute("href")'),
  conversationHref,
)
browser('reload')
browser('wait', 'a[aria-current=page]')
assert.equal(evaluate('location.pathname'), conversationHref)
browser('back')
settle()
assert.equal(evaluate('location.pathname'), new URL(url).pathname)
browser('forward')
settle()
assert.equal(evaluate('location.pathname'), conversationHref)

browser('fill', 'textarea', 'Draft to discard')
browser('set', 'viewport', '320', '640')
settle()
assert.ok(
  evaluate('document.documentElement.scrollWidth <= innerWidth'),
  'Mobile must not overflow horizontally',
)
browser('click', home)
settle()
assert.equal(
  evaluate('!!document.querySelector("[data-mobile=true]")'),
  true,
  'Home opens the mobile Sheet',
)
for (let i = 0; i < 6; i++) {
  browser('press', 'Tab')
  assert.equal(
    evaluate('document.querySelector("[data-mobile=true]").contains(document.activeElement)'),
    true,
    'Mobile focus stays inside the Sheet',
  )
}
browser('press', 'Escape')
settle()
assert.equal(
  evaluate('document.activeElement.getAttribute("aria-label")'),
  'Home',
  'Mobile close restores Home focus',
)
browser('click', home)
browser('click', '[data-mobile=true] a[href="/"]')
settle()
assert.equal(evaluate('location.pathname'), '/')
assert.equal(
  evaluate('document.querySelector("textarea").value'),
  '',
  'New Conversation clears the previous draft',
)
assert.equal(
  evaluate('!!document.querySelector("[data-mobile=true]")'),
  false,
  'Mobile selection closes the Sheet',
)
assert.ok(evaluate('document.documentElement.scrollWidth <= innerWidth'))
browser('fill', 'textarea', 'Another draft')
browser('click', home)
browser('click', '[data-mobile=true] a[href="/"]')
settle()
assert.equal(
  evaluate('document.querySelector("textarea").value'),
  '',
  'New Conversation resets an already selected Home draft',
)
browser('focus', '[aria-label="Account menu"]')
browser('press', 'Enter')
settle()
assert.match(
  evaluate('document.querySelector("[data-slot=dropdown-menu-content]").textContent'),
  /@/,
)
browser('click', '[role=menuitem]')
settle()
assert.equal(
  evaluate(`!!document.querySelector('[aria-label="Account menu"]')`),
  false,
  'Logout clears the profile',
)
assert.deepEqual(browser('errors').errors ?? [], [])
console.log(
  'Navigation browser checks passed: docked, hover transfer/exit, focus, Escape, pin, routes, mobile, account/logout.',
)
