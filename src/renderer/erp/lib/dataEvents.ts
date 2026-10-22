import { useEffect, useRef } from 'react'

/**
 * 业务数据变更广播：抽屉是全局浮层，盖在任意页面上。抽屉里写入成功后调用 emitDataChanged()，
 * 底下的页面用 useDataChanged() 订阅并重新读取，不必层层传回调。
 */
const listeners = new Set<() => void>()

export function emitDataChanged(): void {
  for (const fn of listeners) fn()
}

export function useDataChanged(handler: () => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const fn = (): void => ref.current()
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
}
