import type { ReactElement, ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { RouteParams } from './navigation'
import type { RouteKey, SettingsTarget } from './routes'

/** React 一侧需要摸鱼外壳做的事：同步子菜单、打开设置分节 */
export interface ErpHost {
  /** 页面内部发生跳转（概览 KPI → 单据、模板 → 生产等）后通知外壳同步模块与子菜单 */
  onRoute: (key: RouteKey, params: RouteParams) => void
  openSettings: (target: SettingsTarget) => void
}

const HostContext = createContext<ErpHost>({ onRoute: () => {}, openSettings: () => {} })

export function HostProvider({ host, children }: { host: ErpHost; children: ReactNode }): ReactElement {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

export function useHost(): ErpHost {
  return useContext(HostContext)
}
