import './tooltip.css'

const INITIAL_DELAY = 450
const CANVAS_DELAY = 0
const SWITCH_GRACE = 120
const EDGE_GAP = 8

export function installTooltips(root = document) {
  if (root.querySelector('#app-tooltip')) return

  const tooltip = root.createElement('div')
  tooltip.id = 'app-tooltip'
  tooltip.className = 'app-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  root.body.append(tooltip)

  let active = null
  let openTimer = 0
  let closeTimer = 0

  const targetFor = (node) => node instanceof Element ? node.closest('[data-tip]') : null

  function clearTimers() {
    window.clearTimeout(openTimer)
    window.clearTimeout(closeTimer)
  }

  function position(target) {
    const rect = target.getBoundingClientRect()
    const tip = tooltip.getBoundingClientRect()
    const left = Math.min(
      Math.max(EDGE_GAP, rect.left + (rect.width - tip.width) / 2),
      window.innerWidth - tip.width - EDGE_GAP
    )
    const targetInTopHalf = rect.top + rect.height / 2 < window.innerHeight / 2
    const preferredTop = targetInTopHalf
      ? rect.bottom + EDGE_GAP
      : rect.top - tip.height - EDGE_GAP
    const top = Math.max(
      EDGE_GAP,
      Math.min(preferredTop, window.innerHeight - tip.height - EDGE_GAP)
    )
    tooltip.style.left = `${Math.round(left)}px`
    tooltip.style.top = `${Math.round(top)}px`
    tooltip.dataset.side = targetInTopHalf ? 'bottom' : 'top'
  }

  function show(target, instant, keyboard) {
    if (!target?.isConnected || !target.dataset.tip) return
    if (active && active !== target) active.removeAttribute('aria-describedby')
    active = target
    tooltip.textContent = target.dataset.tip
    tooltip.hidden = false
    tooltip.toggleAttribute('data-instant', instant || keyboard)
    tooltip.toggleAttribute('data-keyboard', keyboard)
    target.setAttribute('aria-describedby', tooltip.id)
    position(target)
  }

  function schedule(target, keyboard = false) {
    clearTimers()
    if (!target || target.getAttribute('aria-disabled') === 'true') return
    const instant = !tooltip.hidden
    const delay = target.closest('#canvas-surface') ? CANVAS_DELAY : INITIAL_DELAY
    openTimer = window.setTimeout(() => show(target, instant, keyboard), instant || keyboard ? 0 : delay)
  }

  function hideSoon(target) {
    window.clearTimeout(openTimer)
    closeTimer = window.setTimeout(() => {
      if (target && active !== target) return
      active?.removeAttribute('aria-describedby')
      active = null
      tooltip.hidden = true
      tooltip.removeAttribute('data-instant')
      tooltip.removeAttribute('data-keyboard')
    }, SWITCH_GRACE)
  }

  root.addEventListener('pointerover', (event) => {
    const target = targetFor(event.target)
    if (target && !target.contains(event.relatedTarget)) schedule(target)
  })
  root.addEventListener('pointerout', (event) => {
    const target = targetFor(event.target)
    if (target && !target.contains(event.relatedTarget)) hideSoon(target)
  })
  root.addEventListener('focusin', (event) => schedule(targetFor(event.target), true))
  root.addEventListener('focusout', (event) => hideSoon(targetFor(event.target)))
  window.addEventListener('blur', () => hideSoon(active))
  window.addEventListener('resize', () => active && position(active))
}
