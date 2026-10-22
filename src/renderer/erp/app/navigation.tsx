import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PsdView, RouteKey } from './routes'
import { useHost } from './host'
import type { DocumentStatus, DocumentType } from '@shared/erp/types'
import { ConfirmDialog } from '@erp/components/ui'

/** 单据页的初始筛选（概览 KPI、待处理条跳过来时带上） */
export interface DocumentsView {
  type?: DocumentType
  status?: DocumentStatus
  from?: string
  to?: string
}

export interface RouteParams {
  documents?: DocumentsView
  psd?: { view?: PsdView }
}

export interface Location {
  key: RouteKey
  params: RouteParams
  /** 每次 navigate 递增；页面以此为 key 重新挂载，保证重新进入时数据刷新 */
  seq: number
}

/** 摸鱼外壳驱动导航用的句柄：子菜单点击 → navigate；离开库存 / 定制模块 → setVisible(false) */
export interface NavHandle {
  navigate: (key: RouteKey, params?: RouteParams) => void
  setVisible: (visible: boolean) => void
}

interface Nav {
  location: Location
  /** 摸鱼当前是否停在库存 / 定制模块；切到别的工具时页面常驻但视为后台 */
  visible: boolean
  navigate: (key: RouteKey, params?: RouteParams) => void
  /** 注册离开守卫：返回提示文案表示有未保存内容，导航前需确认；返回 null 放行 */
  setGuard: (guard: (() => string | null) | null) => void
}

const NavContext = createContext<Nav | null>(null)

export function NavProvider({
  initial,
  handleRef,
  children
}: {
  initial: { key: RouteKey; params?: RouteParams }
  handleRef: { current: NavHandle | null }
  children: ReactNode
}): ReactElement {
  const host = useHost()
  const [location, setLocation] = useState<Location>({
    key: initial.key,
    params: initial.params ?? {},
    seq: 0
  })
  const [visible, setVisible] = useState(true)
  const guardRef = useRef<(() => string | null) | null>(null)
  const [pending, setPending] = useState<{
    key: RouteKey
    params: RouteParams
    message: string
  } | null>(null)

  const go = useCallback((key: RouteKey, params: RouteParams) => {
    guardRef.current = null
    setLocation((l) => ({ key, params, seq: l.seq + 1 }))
  }, [])

  const navigate = useCallback(
    (key: RouteKey, params: RouteParams = {}) => {
      const message = guardRef.current?.() ?? null
      if (message) setPending({ key, params, message })
      else go(key, params)
    },
    [go]
  )

  const setGuard = useCallback((g: (() => string | null) | null) => {
    guardRef.current = g
  }, [])

  handleRef.current = { navigate, setVisible }

  // 每次跳转（包括页面内部发起的）都告诉外壳，让摸鱼的模块高亮与子菜单跟上；初始位置由外壳给定，不回报
  useEffect(() => {
    if (location.seq > 0) host.onRoute(location.key, location.params)
  }, [host, location])

  // 守卫拦下外壳发起的跳转时，外壳子菜单已经切过去了，取消后把它拨回当前页
  const cancelPending = useCallback(() => {
    setPending(null)
    host.onRoute(location.key, location.params)
  }, [host, location])

  const value = useMemo(() => ({ location, visible, navigate, setGuard }), [location, visible, navigate, setGuard])
  return (
    <NavContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        danger
        title="离开当前页面？"
        description={pending?.message ?? ''}
        onOpenChange={(o) => !o && cancelPending()}
        confirmText="放弃修改并离开"
        onCancel={cancelPending}
        onConfirm={() => {
          if (pending) go(pending.key, pending.params)
          setPending(null)
        }}
      />
    </NavContext.Provider>
  )
}

export function useNav(): Nav {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav must be used within NavProvider')
  return ctx
}

/**
 * 注册离开守卫。isDirty 在导航发生时同步求值（通常读一个 ref），
 * 这样保存成功后先把 ref 置 false 再 navigate 就不会误弹确认。组件卸载自动解除。
 */
export function useNavGuard(isDirty: () => boolean, message = '当前单据还没有保存，离开后修改会丢失。'): void {
  const { setGuard } = useNav()
  const fnRef = useRef(isDirty)
  useEffect(() => {
    fnRef.current = isDirty
  })
  useEffect(() => {
    setGuard(() => (fnRef.current() ? message : null))
    return () => setGuard(null)
  }, [message, setGuard])
}
