/**
 * 描述: 替换位置卡片 (SlotCard)
 * 主要功能:
 *   - 显示第 N 位、slot_ID、配置状态与删除按钮
 *   - 狗图 / 名字图小预览，点击只打开对应类别的选图弹窗
 *   - 展开图层映射，失焦或回车保存到模板配置（不修改 PSD 文件）
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, ImagePlus, Trash2 } from 'lucide-react'
import { isSafeLayerName, type PsdAsset, type PsdAssetKind, type PsdSlot } from '@shared/erp/psd'
import { ConfirmDialog, IconButton, Input } from '@erp/components/ui'
import { slotLabel } from './psdLabels'
import styles from './SlotCard.module.css'

export interface SlotCardProps {
  slot: PsdSlot
  dog: PsdAsset | undefined
  name: PsdAsset | undefined
  busy: boolean
  onPick: (kind: PsdAssetKind) => void
  /** 返回错误文案；null 表示保存成功 */
  onSaveMapping: (dogLayer: string, nameLayer: string) => Promise<string | null>
  onDelete: () => Promise<void>
}

const KIND_LABEL: Record<PsdAssetKind, string> = { dog: '狗图', name: '名字图' }

export function SlotCard({ slot, dog, name, busy, onPick, onSaveMapping, onDelete }: SlotCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [dogLayer, setDogLayer] = useState(slot.dogLayer)
  const [nameLayer, setNameLayer] = useState(slot.nameLayer)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const skipBlur = useRef(false)

  useEffect(() => {
    setDogLayer(slot.dogLayer)
    setNameLayer(slot.nameLayer)
  }, [slot.dogLayer, slot.nameLayer])

  const complete = !!dog && !!name
  const status = !slot.dogLayer || !slot.nameLayer ? '未配置' : complete ? '已配置' : '缺素材'

  const save = async (): Promise<void> => {
    if (skipBlur.current) {
      skipBlur.current = false
      return
    }
    const nextDog = dogLayer.trim()
    const nextName = nameLayer.trim()
    if (nextDog === slot.dogLayer && nextName === slot.nameLayer) return
    if (!isSafeLayerName(nextDog) || !isSafeLayerName(nextName)) {
      setError('图层名不能为空，也不能包含 / \\ : * ? " < > |')
      return
    }
    if (nextDog === nextName) {
      setError('狗图图层和名字图层不能同名')
      return
    }
    setSaving(true)
    const message = await onSaveMapping(nextDog, nextName)
    setSaving(false)
    if (message) {
      setError(message)
      return
    }
    setError(null)
  }

  return (
    <article className={styles.card} data-complete={complete || undefined}>
      <header className={styles.head}>
        <div className={styles.titleLine}>
          <span className={styles.position}>{slotLabel(slot.slotKey)}</span>
          <span className={styles.slotKey}>{slot.slotKey}</span>
        </div>
        <div className={styles.headRight}>
          <span className={styles.status} data-complete={complete || undefined}>
            {status}
          </span>
          <IconButton
            label={`删除${slotLabel(slot.slotKey)}`}
            icon={<Trash2 size={14} />}
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          />
        </div>
      </header>

      <div className={styles.previews}>
        {(['dog', 'name'] as const).map((kind) => {
          const asset = kind === 'dog' ? dog : name
          return (
            <button
              key={kind}
              type="button"
              className={styles.preview}
              aria-label={`${slotLabel(slot.slotKey)}${KIND_LABEL[kind]}`}
              disabled={busy}
              onClick={() => onPick(kind)}
            >
              <span className={styles.thumb}>
                {asset ? (
                  <img src={asset.fileUrl} alt="" />
                ) : (
                  <span className={styles.placeholder}>
                    <ImagePlus size={16} />
                  </span>
                )}
              </span>
              <span className={styles.assetName} title={asset?.label}>
                {asset ? asset.label : `选择${KIND_LABEL[kind]}`}
              </span>
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className={styles.mappingToggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronDown size={13} className={expanded ? styles.chevronOpen : undefined} />
        图层映射
      </button>

      {expanded && (
        <div className={styles.mapping}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>狗图层名</span>
            <Input
              value={dogLayer}
              disabled={busy || saving}
              aria-label={`${slotLabel(slot.slotKey)}狗图层名`}
              onChange={(e) => {
                setDogLayer(e.target.value)
                setError(null)
              }}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
                if (e.key === 'Escape') {
                  skipBlur.current = true
                  setDogLayer(slot.dogLayer)
                  setNameLayer(slot.nameLayer)
                  setError(null)
                  e.currentTarget.blur()
                }
              }}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>名字图层名</span>
            <Input
              value={nameLayer}
              disabled={busy || saving}
              aria-label={`${slotLabel(slot.slotKey)}名字图层名`}
              onChange={(e) => {
                setNameLayer(e.target.value)
                setError(null)
              }}
              onBlur={() => void save()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
                if (e.key === 'Escape') {
                  skipBlur.current = true
                  setDogLayer(slot.dogLayer)
                  setNameLayer(slot.nameLayer)
                  setError(null)
                  e.currentTarget.blur()
                }
              }}
            />
          </label>
          {error && <p className={styles.error}>{error}</p>}
          {saving && <p className={styles.saving}>保存中…</p>}
          <p className={styles.hint}>失焦或按回车保存到模板配置，不会改动 PSD 文件。</p>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        danger
        title={`删除${slotLabel(slot.slotKey)}？`}
        description="只删除模板里的这个位置，不改动 PSD 文件，也不会删除已经生成的文件。"
        confirmText="删除位置"
        loading={busy}
        onConfirm={async () => {
          await onDelete()
          setConfirmOpen(false)
        }}
      />
    </article>
  )
}
