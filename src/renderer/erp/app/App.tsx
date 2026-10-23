/**
 * 描述: 库存 / 定制的 React 根
 * 主要功能:
 *   - 一个 React 根，经 portal 分别渲染进摸鱼的 #page-erp（概览 · 商品 · 单据）与 #page-custom（定制）
 *   - 页面常驻（keep-alive），切换子菜单或切到摸鱼其他工具再回来，不丢筛选、滚动和未提交输入
 *   - 抽屉 / 提示 / 导航守卫 / 数据变更广播在两个模块间共用
 */

import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ToastProvider, useToast } from '@erp/components/Toast'
import { DrawerHost, useDrawer } from '@erp/components/ui'
import { NavProvider, useNav, type NavHandle, type RouteParams } from './navigation'
import { HostProvider, type ErpHost } from './host'
import { useEntityDrawers } from './entityDrawers'
import { unwrap, errorMessage } from '@erp/lib/api'
import { emitDataChanged } from '@erp/lib/dataEvents'
import { refreshPsdBoard, subscribePsdBoard } from '@erp/lib/psdBoardFeed'
import type { PsdBoard, PsdJobStatus } from '@shared/erp/psd'
import { INVENTORY_ROUTES, type RouteKey } from './routes'
import { OverviewPage } from '@erp/pages/OverviewPage'
import { ProductsPage } from '@erp/pages/ProductsPage'
import { DocumentsPage } from '@erp/pages/DocumentsPage'
import { PsdPage } from '@erp/pages/PsdPage'
import { DataSettings } from '@erp/features/settings/DataSettings'
import { StorageSettings } from '@erp/features/settings/StorageSettings'
import { PhotoshopSettings } from '@erp/features/psd/PhotoshopSettings'
import styles from './App.module.css'

const PAGES: Record<(typeof INVENTORY_ROUTES)[number], () => ReactElement> = {
  overview: OverviewPage,
  products: ProductsPage,
  documents: DocumentsPage
}

/** 外壳（⌘K、快捷键）可触发的动作 */
export type ErpAction =
  | 'new-outbound'
  | 'new-inbound'
  | 'new-adjustment'
  | 'new-product'
  | 'import-csv'
  | 'export-movements'
  | 'backup-create'

export interface ErpContainers {
  inventory: HTMLElement
  custom: HTMLElement
  /** 摸鱼设置页「存储」「数据管理」「Photoshop 连接」分类的内容区 */
  settingsStorage: HTMLElement | null
  settingsData: HTMLElement | null
  settingsPhotoshop: HTMLElement | null
}

function Routed({
  containers,
  actionRef
}: {
  containers: ErpContainers
  actionRef: { current: ((action: ErpAction) => void) | null }
}): ReactElement {
  const { location } = useNav()
  const toast = useToast()
  const drawers = useEntityDrawers()

  // 页面常驻：访问过的页面保留在 DOM 里，只切换显示状态
  const [visited, setVisited] = useState<Set<RouteKey>>(() => new Set([location.key]))
  useEffect(() => {
    setVisited((prev) => (prev.has(location.key) ? prev : new Set(prev).add(location.key)))
  }, [location.key])

  // 恢复备份后主进程广播 erp:data:replaced：各页面按数据变更重新读取
  useEffect(() => window.api.erp.app.onDataReplaced(emitDataChanged), [])

  actionRef.current = (action: ErpAction): void => {
    switch (action) {
      case 'new-outbound':
        return drawers.newDocument('outbound')
      case 'new-inbound':
        return drawers.newDocument('inbound')
      case 'new-adjustment':
        return drawers.openAdjustment()
      case 'new-product':
        return drawers.newProduct()
      case 'import-csv':
        return drawers.openImport()
      case 'export-movements':
        void unwrap(window.api.erp.csv.exportMovements({}))
          .then((p) => p && toast(`已导出全部流水到: ${p}`, 'success'))
          .catch((err) => toast(errorMessage(err), 'error'))
        return
      case 'backup-create':
        void unwrap(window.api.erp.backup.create())
          .then((p) => p && toast(`备份已保存到: ${p}`, 'success'))
          .catch((err) => toast(errorMessage(err), 'error'))
        return
    }
  }

  return (
    <>
      {createPortal(
        <div className={styles.pageStack}>
          {INVENTORY_ROUTES.filter((key) => visited.has(key)).map((key) => {
            const Page = PAGES[key]
            return (
              <div key={key} className={styles.pageLayer} hidden={key !== location.key}>
                <Page />
              </div>
            )
          })}
        </div>,
        containers.inventory
      )}
      {visited.has('psd') &&
        createPortal(
          <div className={styles.pageStack}>
            <div className={styles.pageLayer}>
              <PsdPage />
            </div>
          </div>,
          containers.custom
        )}
      {containers.settingsStorage && createPortal(<StorageSettings />, containers.settingsStorage)}
      {containers.settingsData && createPortal(<DataSettings />, containers.settingsData)}
      {containers.settingsPhotoshop && createPortal(<PhotoshopSettings />, containers.settingsPhotoshop)}
    </>
  )
}

/** 订阅共享看板（全应用唯一的轮询）：无论在摸鱼哪个工具，定制任务完成 / 失败都弹提示 */
function PsdJobNotifier(): null {
  const toast = useToast()
  const jobStatus = useRef<Map<number, PsdJobStatus> | null>(null)
  useEffect(() => {
    const onBoard = (board: PsdBoard): void => {
      const prev = jobStatus.current
      jobStatus.current = new Map(board.jobs.map((job) => [job.id, job.status]))
      if (!prev) return
      for (const job of board.jobs) {
        const before = prev.get(job.id)
        if (before !== 'queued' && before !== 'running') continue
        if (job.status === 'done') {
          toast(`「${job.title}」已生成`, 'success', {
            label: '显示文件',
            onClick: () => void window.api.erp.psd.revealJob(job.id)
          })
        } else if (job.status === 'failed') {
          toast(`「${job.title}」生成失败：${job.error ?? '原因未知'}`, 'error')
        }
      }
    }
    const unsubscribe = subscribePsdBoard(onBoard, false)
    refreshPsdBoard().catch(() => {})
    return unsubscribe
  }, [toast])
  return null
}

/** 离开库存 / 定制（切到摸鱼其他工具）时收起没有未保存内容的抽屉，免得盖在别的工具上 */
function DrawerVisibility({ visibleRef }: { visibleRef: { current: ((visible: boolean) => void) | null } }): null {
  const { currentDrawer, closeDrawer } = useDrawer()
  visibleRef.current = (visible) => {
    if (!visible && currentDrawer && !currentDrawer.isDirty) closeDrawer(true)
  }
  return null
}

export function App({
  host,
  containers,
  initial,
  navRef,
  actionRef,
  visibleRef,
  onReady
}: {
  host: ErpHost
  containers: ErpContainers
  initial: { key: RouteKey; params?: RouteParams }
  navRef: { current: NavHandle | null }
  actionRef: { current: ((action: ErpAction) => void) | null }
  visibleRef: { current: ((visible: boolean) => void) | null }
  /** 首次提交后调用：此时 navRef / actionRef 都已就绪 */
  onReady: () => void
}): ReactElement {
  useEffect(onReady, [onReady])
  return (
    <HostProvider host={host}>
      <ToastProvider>
        <NavProvider initial={initial} handleRef={navRef}>
          <DrawerHost>
            <DrawerVisibility visibleRef={visibleRef} />
            <PsdJobNotifier />
            <Routed containers={containers} actionRef={actionRef} />
          </DrawerHost>
        </NavProvider>
      </ToastProvider>
    </HostProvider>
  )
}
