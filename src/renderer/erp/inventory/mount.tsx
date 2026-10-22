import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SpikeView } from './SpikeView'

let root: Root | null = null

/** 把库存模块挂进 moyu 的 #page-erp。重复调用不会重复挂载。 */
export function mountInventory(container: Element | null): void {
  if (!container || root) return
  root = createRoot(container)
  root.render(
    <StrictMode>
      <SpikeView />
    </StrictMode>
  )
}
