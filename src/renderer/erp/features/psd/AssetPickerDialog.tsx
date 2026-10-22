/**
 * 描述: 素材选择弹窗 (AssetPickerDialog)
 * 主要功能:
 *   - 只展示当前类别（狗图 / 名字图）的素材，支持搜索
 *   - 单选、确认；也可以直接从当前类别导入图片
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ImagePlus, Search, Upload } from 'lucide-react'
import type { PsdAsset, PsdAssetKind } from '@shared/erp/psd'
import { Button, Input, StandaloneDrawer } from '@erp/components/ui'
import styles from './AssetPickerDialog.module.css'

const KIND_LABEL: Record<PsdAssetKind, string> = { dog: '狗图', name: '名字图' }

export interface AssetPickerDialogProps {
  open: boolean
  kind: PsdAssetKind
  assets: PsdAsset[]
  selectedId: number
  busy?: boolean
  onClose: () => void
  onConfirm: (asset: PsdAsset) => void
  onImport: () => Promise<void>
}

export function AssetPickerDialog({
  open,
  kind,
  assets,
  selectedId,
  busy = false,
  onClose,
  onConfirm,
  onImport
}: AssetPickerDialogProps): ReactElement {
  const [search, setSearch] = useState('')
  const [tempId, setTempId] = useState(selectedId)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!open) return
    setTempId(selectedId)
    setSearch('')
  }, [open, selectedId])

  const list = useMemo(() => {
    const q = search.trim().toLowerCase()
    return assets.filter((a) => a.kind === kind).filter((a) => (q ? a.label.toLowerCase().includes(q) : true))
  }, [assets, kind, search])

  const selected = list.find((a) => a.id === tempId) ?? null

  const doImport = async (): Promise<void> => {
    setImporting(true)
    try {
      await onImport()
    } finally {
      setImporting(false)
    }
  }

  return (
    <StandaloneDrawer
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={`选择${KIND_LABEL[kind]}`}
      size="sm"
      headerActions={
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          disabled={busy || importing}
          onClick={() => void doImport()}
        >
          {importing ? '导入中…' : '＋ 导入'}
        </Button>
      }
      footer={
        <div className={styles.footer}>
          <span className={styles.hint}>{selected ? `已选：${selected.label}` : '请选择一个素材'}</span>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!selected} onClick={() => selected && onConfirm(selected)}>
            确认选择
          </Button>
        </div>
      }
    >
      <div className={styles.root}>
        <div className={styles.search}>
          <Search size={14} className={styles.searchIcon} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索素材名称" />
        </div>

        {list.length === 0 ? (
          <div className={styles.empty}>
            <ImagePlus size={24} />
            <span>{search ? '没有匹配的素材' : `素材库里还没有${KIND_LABEL[kind]}，点右上角导入`}</span>
          </div>
        ) : (
          <div className={styles.grid}>
            {list.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className={styles.item}
                aria-pressed={asset.id === tempId}
                onClick={() => setTempId(asset.id)}
                onDoubleClick={() => onConfirm(asset)}
              >
                <span className={styles.thumb}>
                  <img src={asset.fileUrl} alt="" />
                </span>
                <span className={styles.name} title={asset.label}>
                  {asset.label}
                </span>
                <span className={styles.meta}>
                  {asset.width}×{asset.height}
                  {asset.hasAlpha ? ' · 透明' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </StandaloneDrawer>
  )
}
