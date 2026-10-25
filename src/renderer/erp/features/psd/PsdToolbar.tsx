/**
 * 描述: 定制公共工具栏 (PsdToolbar)
 * 主要功能:
 *   - 生产 / 模板 / 素材库共用的第一行，靠左：Photoshop 状态胶囊 → 打开 PS → 任务记录
 *   - 只由定制页渲染一次，三个视图切换时位置与样式不变
 */

import type { ReactElement } from 'react'
import { ListChecks } from 'lucide-react'
import { Button } from '@erp/components/ui'
import styles from './PsdToolbar.module.css'

export interface PsdToolbarProps {
  /** 未读到看板时为 false，显示「检查中…」 */
  loaded: boolean
  /** 已就绪的 Photoshop 名称；null 表示未就绪 */
  psName: string | null
  busy: boolean
  /** 排队 / 生成中的任务数，0 不显示角标 */
  activeJobs: number
  onCheckPhotoshop: () => void
  onOpenPhotoshop: () => void
  onOpenJobs: () => void
}

export function PsdToolbar({
  loaded,
  psName,
  busy,
  activeJobs,
  onCheckPhotoshop,
  onOpenPhotoshop,
  onOpenJobs
}: PsdToolbarProps): ReactElement {
  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        className={styles.psPill}
        data-ready={psName ? true : undefined}
        title="查看 Photoshop 连接设置"
        onClick={onCheckPhotoshop}
      >
        <span className={styles.dot} aria-hidden="true" />
        {loaded ? (psName ?? '未就绪') : '检查中…'}
      </button>
      <Button variant="secondary" disabled={busy} onClick={onOpenPhotoshop}>
        打开 PS
      </Button>
      <Button variant="secondary" icon={<ListChecks size={14} />} onClick={onOpenJobs}>
        任务记录
        {activeJobs > 0 && <span className={styles.jobsCount}>{activeJobs}</span>}
      </Button>
    </div>
  )
}
