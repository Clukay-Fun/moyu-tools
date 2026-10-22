/**
 * 描述: 定制页 (PsdPage)
 * 主要功能:
 *   - 三个平级视图：生产 / 模板 / 素材库，由摸鱼「定制」子菜单切换
 *   - 页头：Photoshop 状态胶囊（去设置检查）、打开 PS、任务记录
 *   - 看板来自共享轮询源（lib/psdBoardFeed）：本页在前台时提速到 1.5 秒；任务完成 / 失败的 Toast 由外壳负责
 *   - 素材删除前检查排队中任务与生产页选择；抠白底结果自动弹出确认
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ListChecks } from 'lucide-react'
import type { PsdAsset, PsdBoard, PsdTemplate } from '@shared/erp/psd'
import { Button, ConfirmDialog, useDrawer } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useNav } from '@erp/app/navigation'
import { useHost } from '@erp/app/host'
import { usePageActive } from '@erp/app/usePageActive'
import { unwrap, errorMessage } from '@erp/lib/api'
import { usePsdBoard } from '@erp/lib/psdBoardFeed'
import { ProductionView } from '@erp/features/psd/ProductionView'
import { TemplatesView } from '@erp/features/psd/TemplatesView'
import { AssetLibraryView } from '@erp/features/psd/AssetLibraryView'
import { NewTemplateDialog } from '@erp/features/psd/NewTemplateDialog'
import { JobsPanel } from '@erp/features/psd/JobsPanel'
import { CutoutReview } from '@erp/features/psd/CutoutReview'
import { fileName } from '@erp/features/psd/psdLabels'
import styles from './PsdPage.module.css'

type View = 'production' | 'templates' | 'assets'
const VIEW_TITLES: Record<View, string> = { production: '生产', templates: '模板', assets: '素材库' }
const TEMPLATE_KEY = 'moyu.erp.psdTemplateId'

function readStoredTemplateId(): number | null {
  try {
    const v = Number(localStorage.getItem(TEMPLATE_KEY))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

export function PsdPage(): ReactElement {
  const toast = useToast()
  const { location, navigate } = useNav()
  const host = useHost()
  const { openDrawer } = useDrawer()
  const { active } = usePageActive('psd')
  const lastView = useRef<View>('production')
  // 生产 / 模板 / 素材库由摸鱼的定制子菜单切换；页面内的跳转也走导航，子菜单随之同步
  const view: View = location.key === 'psd' ? (location.params.psd?.view ?? 'production') : lastView.current
  lastView.current = view
  const setView = useCallback((next: View) => navigate('psd', { psd: { view: next } }), [navigate])
  const [board, setBoard, refreshBoard] = usePsdBoard(active)
  const [templateId, setTemplateId] = useState<number | null>(readStoredTemplateId)
  const [busy, setBusy] = useState(false)
  const [deletingAsset, setDeletingAsset] = useState<PsdAsset | null>(null)
  const [deleteNote, setDeleteNote] = useState('')
  const [reviewId, setReviewId] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set())
  const selection = useRef<{ ids: Set<number>; clear: () => void }>({ ids: new Set(), clear: () => {} })

  // 切到定制页时立即补拉一次；之后由共享轮询源按 1.5 秒刷新，切走后回落到低频
  useEffect(() => {
    if (!active) return
    refreshBoard().catch((err: unknown) => toast(errorMessage(err), 'error'))
  }, [active, refreshBoard, toast])

  // 记住模板选择；失效时回落到第一个模板
  const chooseTemplate = useCallback((id: number) => {
    setTemplateId(id)
    try {
      localStorage.setItem(TEMPLATE_KEY, String(id))
    } catch {
      // 记不住也不影响本次使用
    }
  }, [])

  useEffect(() => {
    if (!board) return
    if (templateId && board.templates.some((t) => t.id === templateId)) return
    const first = board.templates[0]
    if (first) chooseTemplate(first.id)
  }, [board, templateId, chooseTemplate])

  // 抠白底结果就绪时自动弹出预览；用户关掉的不再自动弹
  useEffect(() => {
    if (reviewId !== null) return
    const ready = board?.cutouts.find((c) => c.status === 'ready' && !dismissed.has(c.id))
    if (ready) setReviewId(ready.id)
  }, [board, dismissed, reviewId])

  const act = useCallback(
    async (fn: () => Promise<PsdBoard | null>, ok?: string): Promise<void> => {
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
    },
    [setBoard, toast]
  )

  const importAsset = useCallback(
    async (kind: 'dog' | 'name'): Promise<void> => {
      await act(() => unwrap(window.api.erp.psd.importAsset(kind)), kind === 'dog' ? '狗图已导入' : '名字图已导入')
    },
    [act]
  )

  function useTemplate(template: PsdTemplate): void {
    chooseTemplate(template.id)
    setView('production')
  }

  function openNewTemplate(): void {
    openDrawer({
      id: 'psd-template-new',
      title: '新建模板',
      size: 'sm',
      content: (
        <NewTemplateDialog
          onCreated={(next, id) => {
            setBoard(next)
            chooseTemplate(id)
            setView('production')
          }}
        />
      )
    })
  }

  function openJobs(): void {
    openDrawer({
      id: 'psd-jobs',
      title: '生成任务',
      size: 'sm',
      content: <JobsPanel />
    })
  }

  // 删除素材前：排队 / 生成中的任务引用则拒绝；生产页选择引用则先清除并提示
  function requestDeleteAsset(asset: PsdAsset): void {
    const activeJob = board?.jobs.find(
      (job) =>
        (job.status === 'queued' || job.status === 'running') &&
        job.items.some((item) => item.dogAssetId === asset.id || item.nameAssetId === asset.id)
    )
    if (activeJob) {
      toast(`这个素材正被「${activeJob.title}」使用，等任务结束再删除`, 'error')
      return
    }
    const usedInProduction = selection.current.ids.has(asset.id)
    if (usedInProduction) {
      selection.current.clear()
      setDeleteNote('这个素材已在生产页选择中被清除。')
      toast('已从生产页选择中清除这个素材', 'success')
    } else {
      setDeleteNote('')
    }
    setDeletingAsset(asset)
  }

  const review = board?.cutouts.find((c) => c.id === reviewId && c.status === 'ready') ?? null

  async function finishCutout(confirm: boolean): Promise<void> {
    if (!review) return
    await act(
      () => unwrap(confirm ? window.api.erp.psd.confirmCutout(review.id) : window.api.erp.psd.cancelCutout(review.id)),
      confirm ? '已新增透明素材，原图保留' : '已删掉这次抠图结果'
    )
    setReviewId(null)
  }

  const psName = board?.photoshopPath ? fileName(board.photoshopPath).replace(/\.(app|exe)$/i, '') : null
  const activeJobs = board?.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length ?? 0

  return (
    <div className={styles.container}>
      <h1 className="srOnly">定制</h1>

      <header className={styles.header}>
        <div className={styles.headLeft}>
          <h2 className={styles.viewTitle}>{VIEW_TITLES[view]}</h2>
        </div>
        <div className={styles.headRight}>
          <button
            type="button"
            className={styles.psPill}
            data-ready={psName ? true : undefined}
            title="查看 Photoshop 连接设置"
            onClick={() => host.openSettings('custom')}
          >
            <span className={styles.dot} aria-hidden="true" />
            {board ? (psName ?? '未就绪') : '检查中…'}
          </button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => unwrap(window.api.erp.psd.openPhotoshop()).then(() => null))}
          >
            打开 PS
          </Button>
          <button type="button" className={styles.jobsButton} onClick={openJobs}>
            <ListChecks size={14} />
            任务记录
            {activeJobs > 0 && <span className={styles.jobsCount}>{activeJobs}</span>}
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.pane} hidden={view !== 'production'}>
          <ProductionView
            board={board}
            busy={busy}
            psReady={!!psName}
            templateId={templateId}
            onChooseTemplate={chooseTemplate}
            onAct={act}
            onBoard={setBoard}
            onNewTemplate={openNewTemplate}
            onGoTemplates={() => setView('templates')}
            onImport={importAsset}
            onSelectionChange={(ids, clear) => {
              selection.current = { ids, clear }
            }}
          />
        </div>
        <div className={styles.pane} hidden={view !== 'templates'}>
          <TemplatesView
            board={board}
            busy={busy}
            onAct={act}
            onBoard={setBoard}
            onNew={openNewTemplate}
            onUse={useTemplate}
          />
        </div>
        <div className={styles.pane} hidden={view !== 'assets'}>
          <AssetLibraryView
            board={board}
            busy={busy}
            onAct={act}
            onImport={importAsset}
            onReviewCutout={(id) => {
              setDismissed((s) => {
                const next = new Set(s)
                next.delete(id)
                return next
              })
              setReviewId(id)
            }}
            onDeleteAsset={requestDeleteAsset}
          />
        </div>
      </div>

      <ConfirmDialog
        open={deletingAsset !== null}
        onOpenChange={(open) => !open && setDeletingAsset(null)}
        danger
        title="删除素材？"
        description={deletingAsset ? `${deleteNote}「${deletingAsset.label}」会从素材库去掉，已经生成的文件还在。` : ''}
        confirmText="删除"
        loading={busy}
        onConfirm={async () => {
          const target = deletingAsset
          if (!target) return
          await act(() => unwrap(window.api.erp.psd.deleteAsset(target.id)), '素材已删除')
          setDeletingAsset(null)
        }}
      />
      <CutoutReview
        open={review !== null}
        job={review}
        original={board?.assets.find((a) => a.id === review?.assetId) ?? null}
        busy={busy}
        onDismiss={() => {
          if (review) setDismissed((s) => new Set(s).add(review.id))
          setReviewId(null)
        }}
        onConfirm={() => void finishCutout(true)}
        onCancel={() => void finishCutout(false)}
      />
    </div>
  )
}
