/**
 * 描述: 定制任务列表 (JobsPanel)
 * 主要功能:
 *   - 在「任务」弹窗里列出生成任务：状态、标题、时间、模板与位置
 *   - 完成：在 Finder / 资源管理器中显示；失败：显示原因并可重试；排队中可取消
 *   - 顶部「同步结果」；弹窗内容不随页面重渲染，所以自己订阅共享看板，打开期间按 1.5 秒刷新
 */

import { useEffect, useState, type ReactElement } from 'react'
import { CheckCircle2, Clock, Loader2, XCircle, MinusCircle, RefreshCw } from 'lucide-react'
import type { PsdBoard, PsdJob, PsdJobStatus } from '@shared/erp/psd'
import { Button } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { usePsdBoard } from '@erp/lib/psdBoardFeed'
import { JOB_STATUS_LABEL, shortTime, slotLabel } from './psdLabels'
import styles from './JobsPanel.module.css'

const revealLabel = navigator.platform.toUpperCase().includes('MAC') ? '在 Finder 中显示' : '在文件夹中显示'

const STATUS_ICON: Record<PsdJobStatus, ReactElement> = {
  queued: <Clock size={16} />,
  running: <Loader2 size={16} className={styles.spin} />,
  done: <CheckCircle2 size={16} />,
  failed: <XCircle size={16} />,
  cancelled: <MinusCircle size={16} />
}

export function JobsPanel(): ReactElement {
  const toast = useToast()
  const [board, setBoard, load] = usePsdBoard(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  async function act(fn: () => Promise<PsdBoard | null>, ok?: string): Promise<void> {
    setBusy(true)
    try {
      const next = await fn()
      if (next) setBoard(next)
      if (ok && next) toast(ok, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const jobs = board?.jobs ?? []
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.count}>{board ? `共 ${jobs.length} 个任务` : '正在读取…'}</span>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={14} />}
          disabled={busy}
          onClick={() => void act(() => unwrap(window.api.erp.psd.sync()), '已同步')}
        >
          同步结果
        </Button>
      </div>
      {board && !jobs.length && <p className={styles.empty}>还没有生成过文件。</p>}
      <ul className={styles.list}>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} busy={busy} onAct={act} />
        ))}
      </ul>
    </div>
  )
}

function JobRow({
  job,
  busy,
  onAct
}: {
  job: PsdJob
  busy: boolean
  onAct: (fn: () => Promise<PsdBoard | null>, ok?: string) => Promise<void>
}): ReactElement {
  const slots = job.items.map((item) => slotLabel(item.slotKey)).join('、')
  return (
    <li className={styles.row} data-status={job.status}>
      <span className={styles.icon} aria-hidden="true">
        {STATUS_ICON[job.status]}
      </span>
      <div className={styles.body}>
        <div className={styles.titleLine}>
          <strong className={styles.title}>{job.title}</strong>
          <span className={styles.status}>{JOB_STATUS_LABEL[job.status]}</span>
        </div>
        <div className={styles.meta}>
          {shortTime(job.finishedAt ?? job.createdAt)} · {job.templateName}
          {slots ? ` · ${slots}` : ''}
        </div>
        {job.error && <div className={styles.error}>{job.error}</div>}
      </div>
      <div className={styles.actions}>
        {job.status === 'done' && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void onAct(() => unwrap(window.api.erp.psd.revealJob(job.id)).then(() => null))}
          >
            {revealLabel}
          </Button>
        )}
        {job.status === 'failed' && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void onAct(() => unwrap(window.api.erp.psd.retryJob(job.id)), '已重新排队')}
          >
            重试
          </Button>
        )}
        {job.status === 'queued' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void onAct(() => unwrap(window.api.erp.psd.cancelJob(job.id)), '任务已取消')}
          >
            取消
          </Button>
        )}
      </div>
    </li>
  )
}
