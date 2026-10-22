import { useEffect, useState } from 'react'

/**
 * 让弹层在 open=false 后还挂载一小段时间播放退出动画。
 * 返回 mounted（是否渲染）与 closing（是否处于退出态，用于加 data-closing）。
 * 退出比进入快：默认 160ms。
 */
export function usePresence(open: boolean, exitMs = 160): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const t = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, exitMs)
    return () => window.clearTimeout(t)
  }, [open, mounted, exitMs])
  return { mounted, closing }
}
