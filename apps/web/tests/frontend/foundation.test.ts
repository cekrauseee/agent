import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useIsMobile } from '../../hooks/use-mobile'

test('the mobile hook renders a stable server snapshot without browser globals', () => {
  function MobileState() {
    return createElement('span', null, String(useIsMobile()))
  }

  assert.equal(renderToString(createElement(MobileState)), '<span>false</span>')
})
