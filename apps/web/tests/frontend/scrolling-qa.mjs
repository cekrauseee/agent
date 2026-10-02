// Local-only geometry proof. Creates a temporary fixture route and removes it on exit.
// Run: node tests/frontend/scrolling-qa.mjs [port]
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = Number(process.argv[2] ?? 3104)
const route = resolve('app/scrolling-qa')
const session = `scrolling-qa-${port}`
const browser = (args, input) =>
  execFileSync('pnpm', ['dlx', 'agent-browser', '--session', session, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
await mkdir(route)
await writeFile(
  resolve(route, 'page.tsx'),
  "export { default } from '@/tests/frontend/scrolling-fixture'\n",
)
const server = spawn('pnpm', ['dev', '--port', String(port)], { detached: true, stdio: 'ignore' })
try {
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://localhost:${port}/scrolling-qa`)).ok
    } catch {}
    if (ready) break
    await new Promise((done) => setTimeout(done, 100))
  }
  if (!ready) throw new Error('Fixture server did not start')
  const check = await readFile('tests/frontend/scrolling.browser.mjs', 'utf8')
  for (const [width, height] of [
    [1024, 633],
    [390, 844],
  ]) {
    browser(['set', 'viewport', String(width), String(height)])
    browser(['open', `http://localhost:${port}/scrolling-qa`])
    const results = JSON.parse(browser(['eval', '--stdin'], check))
    console.log(`${width}x${height}: ${results.length} geometry assertions passed`)
  }
  const geometry = `async () => {
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame)
    return { top: document.querySelector('[data-slot="message-scroller-viewport"]').scrollTop,
      space: document.querySelector('[data-turn-spacer]').getBoundingClientRect().height }
  }`
  const beforeWheel = JSON.parse(
    browser(
      ['eval', '--stdin'],
      `(async () => {
    window.scrollingFixture({ conversationId: 'wheel', sidebar: 0, composer: 80,
      rows: [{ id: 'old', height: 1000 }, { id: 'wheel-user', height: 24 }, { id: 'wheel-answer', height: 400 }],
      submission: { conversationId: 'wheel', userMessageId: 'wheel-user', generationId: 'wheel-gen' } })
    return (${geometry})()
  })()`,
    ),
  )
  browser(['focus', '[data-slot=message-scroller-viewport]'])
  browser(['press', 'ArrowUp'])
  const partial = JSON.parse(browser(['eval', '--stdin'], `(${geometry})()`))
  if (!(partial.top < beforeWheel.top && partial.space === beforeWheel.space))
    throw new Error(
      `Native keyboard partial-visibility failed: ${JSON.stringify({ beforeWheel, partial })}`,
    )
  browser(['press', 'PageUp'])
  const outside = JSON.parse(browser(['eval', '--stdin'], `(${geometry})()`))
  if (outside.space !== 0) throw new Error('Native keyboard fully-outside discard failed')
  console.log('Native keyboard: partial visibility retained; fully outside discarded')
  browser(['reload'])
  browser(
    ['eval', '--stdin'],
    `(() => {
    const space = document.querySelector('[data-turn-spacer]')
    if (space.getBoundingClientRect().height !== 0 || !document.querySelector('[data-message-id="saved-user"]')) throw new Error('Reload fabricated a submission')
    return 'Reload keeps saved history without new-send space'
  })()`,
  )
  console.log('Reload: saved history has no fabricated submission space')
  const errors = browser(['errors']).trim()
  if (errors) throw new Error(errors)
} finally {
  browser(['close'])
  process.kill(-server.pid, 'SIGTERM')
  await rm(route, { recursive: true })
  await rm(resolve('.next/dev/types'), { recursive: true, force: true })
  await rm(resolve('.next/types'), { recursive: true, force: true })
}
