/**
 * 描述: 定制 › 素材库视图 (AssetLibraryView)
 * 主要功能:
 *   - 狗图 / 名字图二级切换，显示数量、导入与素材网格
 *   - 每个素材可抠白底、查看抠图结果、删除（引用检查由页面统一处理）
 *   - 生成时使用素材原图；缩略图只用于浏览
 */

import { useMemo, useState, type ReactElement } from 'react'
import { ImagePlus, Trash2, Upload, Wand2 } from 'lucide-react'
import type { PsdAsset, PsdAssetKind, PsdBoard } from '@shared/erp/psd'
import { Button, EmptyState, IconButton, SegmentedControl } from '@erp/components/ui'
import { unwrap } from '@erp/lib/api'
import { CUTOUT_STATUS_LABEL } from './psdLabels'
import styles from './AssetLibraryView.module.css'

const KIND_LABEL: Record<PsdAssetKind, string> = { dog: '狗图', name: '名字图' }

export interface AssetLibraryViewProps {
  board: PsdBoard | null
  busy: boolean
  onAct: (fn: () => Promise<PsdBoard | null>, ok?: string) => Promise<void>
  onImport: (kind: PsdAssetKind) => Promise<void>
  onReviewCutout: (jobId: number) => void
  onDeleteAsset: (asset: PsdAsset) => void
}

export function AssetLibraryView({
  board,
  busy,
  onAct,
  onImport,
  onReviewCutout,
  onDeleteAsset
}: AssetLibraryViewProps): ReactElement {
  const [kind, setKind] = useState<PsdAssetKind>('dog')
  const assets = board?.assets ?? []
  const list = assets.filter((a) => a.kind === kind)

  const cutoutByAsset = useMemo(() => {
    const map = new Map<number, NonNullable<PsdBoard['cutouts']>[number]>()
    for (const job of board?.cutouts ?? []) {
      if (['queued', 'running', 'ready', 'failed'].includes(job.status) && !map.has(job.assetId)) {
        map.set(job.assetId, job)
      }
    }
    return map
  }, [board?.cutouts])

  return (
    <section className={styles.root} aria-label="素材库">
      <div className={styles.toolbar}>
        <SegmentedControl
          options={[
            { value: 'dog', label: '狗图', count: assets.filter((a) => a.kind === 'dog').length || undefined },
            { value: 'name', label: '名字图', count: assets.filter((a) => a.kind === 'name').length || undefined }
          ]}
          value={kind}
          onChange={setKind}
        />
        <span className={styles.count}>
          共 {list.length} 个{KIND_LABEL[kind]}
        </span>
        <span className={styles.spacer} />
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          disabled={busy}
          onClick={() => void onImport(kind)}
        >
          ＋ 导入图片
        </Button>
      </div>

      <p className={styles.hint}>
        支持 PNG / JPG；生成时使用原图。白底图可以先抠白底，确认后另存一张透明素材，原图保留。
      </p>

      {!board ? (
        <div className={styles.loading}>正在读取素材…</div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ImagePlus size={24} />}
          title={`还没有${KIND_LABEL[kind]}`}
          description={`导入 PNG 或 JPG 后会出现在这里，生产页选图时可直接使用。`}
          actions={[{ label: `导入${KIND_LABEL[kind]}`, variant: 'primary', onClick: () => void onImport(kind) }]}
        />
      ) : (
        <ul className={styles.grid}>
          {list.map((asset) => {
            const cutout = cutoutByAsset.get(asset.id)
            const pending = cutout && cutout.status !== 'failed'
            return (
              <li key={asset.id} className={styles.item}>
                <div className={styles.thumb}>
                  <img src={asset.fileUrl} alt={asset.label} loading="lazy" />
                  {cutout && (
                    <span className={styles.badge} data-status={cutout.status}>
                      {CUTOUT_STATUS_LABEL[cutout.status]}
                    </span>
                  )}
                </div>
                <div className={styles.name} title={asset.label}>
                  {asset.label}
                </div>
                <div className={styles.meta}>
                  {asset.width}×{asset.height}
                  {asset.hasAlpha ? ' · 透明' : ''}
                </div>
                <div className={styles.actions}>
                  {cutout?.status === 'ready' ? (
                    <Button variant="secondary" size="sm" onClick={() => onReviewCutout(cutout.id)}>
                      查看结果
                    </Button>
                  ) : (
                    <IconButton
                      label={pending ? '抠白底处理中' : '抠白底'}
                      icon={<Wand2 size={14} />}
                      size="sm"
                      disabled={busy || !!pending}
                      onClick={() => void onAct(() => unwrap(window.api.erp.psd.createCutout(asset.id)), '已开始抠白底')}
                    />
                  )}
                  <IconButton
                    label="删除素材"
                    icon={<Trash2 size={14} />}
                    size="sm"
                    disabled={busy || !!pending}
                    onClick={() => onDeleteAsset(asset)}
                  />
                </div>
                {cutout?.status === 'failed' && cutout.error && (
                  <div className={styles.error} title={cutout.error}>
                    抠图失败：{cutout.error}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
