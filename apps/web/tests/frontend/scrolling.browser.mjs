// Run with agent-browser eval --stdin against scrolling-fixture.tsx; no API calls are made.
;(async () => {
  const settled = async () => {
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame)
  }
  const patch = async (value) => {
    window.scrollingFixture(value)
    await settled()
  }
  const view = () => document.querySelector('[data-slot="message-scroller-viewport"]')
  const space = () => document.querySelector('[data-turn-spacer]')
  const row = (id) =>
    Array.from(document.querySelectorAll('[data-message-id]')).find(
      (item) => item.dataset.messageId === id,
    )
  const height = () => space().getBoundingClientRect().height
  const top = () => view().scrollTop
  const offset = (id) => row(id).getBoundingClientRect().top - view().getBoundingClientRect().top
  const results = []
  const check = (condition, label, detail) => {
    if (!condition) throw new Error(`${label}: ${JSON.stringify(detail)}`)
    results.push({ label, detail })
  }
  const stationary = (before, label) =>
    check(Math.abs(top() - before) < 1, label, { before, after: top() })
  const userScroll = async (scrollTop) => {
    view().dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: scrollTop - top() }))
    view().scrollTop = scrollTop
    await settled()
  }
  check(height() === 0, 'initial history does not reserve send space', height())
  let rows = []
  for (let turn = 1; turn <= 3; turn++) {
    rows = [...rows, { id: `u${turn}`, height: 24 }, { id: `a${turn}`, height: 24 }]
    await patch({
      rows,
      submission: { conversationId: 'a', userMessageId: `u${turn}`, generationId: `g${turn}` },
    })
    check(Math.abs(offset(`u${turn}`) - 16) < 1, `short turn ${turn} anchors at inset`, {
      offset: offset(`u${turn}`),
      spacer: height(),
      viewport: view().clientHeight,
    })
  }
  await patch({ sidebar: 280, composer: 120 })
  check(
    Math.abs(offset('u3') - 16) < 1,
    'active turn survives composer growth and sidebar expansion',
    { offset: offset('u3'), spacer: height(), viewport: view().clientHeight },
  )
  await patch({ sidebar: 0, composer: 80 })
  check(
    Math.abs(offset('u3') - 16) < 1,
    'active turn survives composer shrink and sidebar collapse',
    { offset: offset('u3'), spacer: height(), viewport: view().clientHeight },
  )
  const anchored = top()
  let previous = height()
  for (const growth of [100, 200, 350, 700, 1100]) {
    rows = rows.map((item) => (item.id === 'a3' ? { ...item, height: growth } : item))
    await patch({ rows })
    check(height() <= previous, `gradual growth ${growth} consumes space`, {
      before: previous,
      after: height(),
    })
    stationary(anchored, `gradual growth ${growth} leaves reader stationary`)
    previous = height()
  }
  check(height() === 0, 'long response consumes all space', height())
  await patch({ rows: rows.map((item) => (item.id === 'a3' ? { ...item, height: 24 } : item)) })
  check(height() === 0, 'editing layout cannot resurrect consumed spacer', height())
  rows = [...rows, { id: 'u4', height: 24 }, { id: 'a4', height: 400 }]
  await patch({
    rows,
    submission: { conversationId: 'a', userMessageId: 'u4', generationId: 'g4' },
  })
  check(height() > 0, 'new generation reserves fresh space', height())
  const reserve = height()
  const spacerOffset =
    space().getBoundingClientRect().top - view().getBoundingClientRect().top + top()
  await userScroll(spacerOffset - view().clientHeight + 12)
  check(height() === reserve, 'partly visible spacer stays reserved', {
    height: height(),
    top: space().getBoundingClientRect().top,
    bottom: view().getBoundingClientRect().bottom,
  })
  await userScroll(spacerOffset - view().clientHeight - 12)
  check(height() === 0, 'fully outside upward spacer is discarded', height())
  await userScroll(view().scrollHeight)
  await patch({ composer: 130, sidebar: 0 })
  check(
    height() === 0,
    'downward scroll and layout resize cannot resurrect discarded spacer',
    height(),
  )
  await patch({ rows: rows.map((item) => (item.id === 'a4' ? { ...item, height: 450 } : item)) })
  check(height() === 0, 'late stream update cannot resurrect discarded spacer', height())
  await patch({ rows: rows.map((item) => (item.id === 'a4' ? { ...item, height: 24 } : item)) })
  check(height() === 0, 'short edit buffer cannot resurrect discarded spacer', height())
  rows = rows.map((item) => (item.id === 'a4' ? { ...item, height: 24 } : item))
  await patch({
    rows,
    submission: { conversationId: 'a', userMessageId: 'u4', generationId: 'edit4' },
  })
  check(
    Math.abs(offset('u4') - 16) < 1 && height() > 0,
    'same user ID with new generation starts a turn',
    { offset: offset('u4'), spacer: height() },
  )
  const editTop = top()
  await patch({ submission: { conversationId: 'a', userMessageId: 'u4', generationId: 'g4' } })
  stationary(editTop, 'stale submission identity cannot restart positioning')
  rows = rows.map((item) => (item.id === 'a4' ? { ...item, height: 1300 } : item))
  await patch({
    rows,
    submission: { conversationId: 'a', userMessageId: 'u4', generationId: 'edit4' },
  })
  stationary(editTop, 'single-batch growth remains stationary')
  check(height() === 0, 'single-batch growth exhausts reservation', height())
  await userScroll(50)
  const olderTop = top()
  const selection = getSelection()
  const range = document.createRange()
  range.selectNodeContents(row('u1'))
  selection.removeAllRanges()
  selection.addRange(range)
  rows = rows.map((item) => (item.id === 'a4' ? { ...item, height: 1600 } : item))
  await patch({ rows })
  stationary(olderTop, 'older reading and text selection survive tokens')
  const oldOffset = offset('u1')
  rows = [{ id: 'earlier-user', height: 70 }, { id: 'earlier-answer', height: 100 }, ...rows]
  await patch({ rows })
  check(Math.abs(offset('u1') - oldOffset) < 1, 'prepended history preserves visible row', {
    before: oldOffset,
    after: offset('u1'),
  })
  const jump = document.querySelector('[data-slot="message-scroller-button"]')
  check(jump.dataset.active === 'true', 'registry jump control appears', jump.dataset.active)
  jump.click()
  await settled()
  check(
    Math.abs(top() + view().clientHeight - view().scrollHeight) < 1,
    'jump moves to current end',
    { top: top(), height: view().clientHeight, total: view().scrollHeight },
  )
  const jumpTop = top()
  rows = rows.map((item) => (item.id === 'a4' ? { ...item, height: 1900 } : item))
  await patch({ rows })
  stationary(jumpTop, 'jump does not resume following')
  rows = rows.map((item) => (item.id === 'a4' ? { ...item, height: 24 } : item))
  await patch({
    rows,
    submission: { conversationId: 'a', userMessageId: 'u4', generationId: 'retry4' },
  })
  check(height() > 0, 'retry with new generation reserves space', height())
  await userScroll(top() - 30)
  document.querySelector('[data-slot="message-scroller-button"]').click()
  await settled()
  check(
    height() === 0 && Math.abs(top() + view().clientHeight - view().scrollHeight) < 1,
    'jump before consumption removes reservation and reaches actual content end',
    { spacer: height(), top: top(), total: view().scrollHeight },
  )
  await patch({ composer: 60, sidebar: 200 })
  check(height() === 0, 'larger viewport keeps exhausted spacer zero', height())
  await patch({
    conversationId: 'b',
    submission: null,
    rows: [
      { id: 'saved-user', height: 24 },
      { id: 'saved-answer', height: 24 },
    ],
  })
  check(height() === 0, 'route history has no fabricated send spacer', height())
  await patch({ conversationId: 'a', submission: null, rows })
  check(height() === 0, 'route return history keeps spacer absent', height())
  check(!document.querySelector('[data-nextjs-dialog]'), 'no framework error overlay', true)
  return results
})()
