import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App, type ErpAction, type ErpContainers } from './app/App'
import type { ErpHost } from './app/host'
import type { NavHandle, RouteParams } from './app/navigation'
import type { RouteKey } from './app/routes'
import './styles/erp.css'

/** 摸鱼外壳（main.js）拿到的控制句柄 */
export interface ErpController {
  navigate: (key: RouteKey, params?: RouteParams) => void
  setVisible: (visible: boolean) => void
  run: (action: ErpAction) => void
}

/**
 * 挂载库存 / 定制。只调用一次：一个 React 根，经 portal 渲染进两个页面容器。
 * React 的事件委托挂在根容器与 portal 容器上，根容器本身不显示。
 */
export function mountErp(
  containers: ErpContainers,
  host: ErpHost,
  initial: { key: RouteKey; params?: RouteParams }
): ErpController {
  const rootNode = document.createElement('div')
  rootNode.hidden = true
  rootNode.dataset.erpRoot = ''
  document.body.append(rootNode)

  const navRef: { current: NavHandle | null } = { current: null }
  const actionRef: { current: ((action: ErpAction) => void) | null } = { current: null }
  const visibleRef: { current: ((visible: boolean) => void) | null } = { current: null }
  // 首帧渲染前到达的指令先排队
  const queued: Array<() => void> = []
  let ready = false
  const whenReady = (fn: () => void): void => {
    if (ready) fn()
    else queued.push(fn)
  }
  const flush = (): void => {
    ready = true
    while (queued.length) queued.shift()!()
  }

  createRoot(rootNode).render(
    <StrictMode>
      <App
        host={host}
        containers={containers}
        initial={initial}
        navRef={navRef}
        actionRef={actionRef}
        visibleRef={visibleRef}
        onReady={flush}
      />
    </StrictMode>
  )

  return {
    navigate: (key, params) => whenReady(() => navRef.current?.navigate(key, params)),
    setVisible: (visible) =>
      whenReady(() => {
        navRef.current?.setVisible(visible)
        visibleRef.current?.(visible)
      }),
    run: (action) => whenReady(() => actionRef.current?.(action))
  }
}
