import { useEffect, useRef, useState } from 'react'
import { useNav } from './navigation'
import type { RouteKey } from './routes'

export interface PageActiveState {
  /** 当前页面是否就是正在显示的业务页 */
  active: boolean
  /** 每次从隐藏变为显示时 +1；初始挂载为 0，页面可用它触发刷新 */
  activation: number
  /** 每次导航到本页时 +1（包括再次点当前页）；初始挂载为 0，用于刷新数据 */
  visit: number
}

/**
 * 页面常驻（keep-alive）后，页面不会被卸载，用这个钩子判断自己是否在前台。
 * 隐藏页应据此暂停轮询、全局快捷键与定时器，重新激活时刷新数据。
 */
export function usePageActive(key: RouteKey): PageActiveState {
  const { location, visible } = useNav()
  const active = visible && location.key === key
  const wasActive = useRef(active)
  const [activation, setActivation] = useState(0)
  const [visit, setVisit] = useState(0)
  const lastSeq = useRef(location.seq)

  useEffect(() => {
    if (active && !wasActive.current) setActivation((n) => n + 1)
    wasActive.current = active
  }, [active])

  useEffect(() => {
    if (location.key !== key || location.seq === lastSeq.current) return
    lastSeq.current = location.seq
    setVisit((n) => n + 1)
  }, [key, location.key, location.seq])

  return { active, activation, visit }
}
